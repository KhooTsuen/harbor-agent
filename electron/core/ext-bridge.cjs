/**
 * 浏览器扩展 ↔ Harbor 主进程的桥（**双向**）
 *
 * Edge 拉起的 native host 是**另一个进程**（见 native-host.cjs），拿不到主进程的内存态
 * （会话、审计、当前打开的对话）。所以需要一条路把请求送进主进程、再把结果拿回去 ——
 * 那就是这里（`net.createServer` 收命名管道）。帧格式与报文形状的唯一真相源是
 * `core/ext-protocol.cjs`。
 *
 * ★ 裸 JSON 兜底（新旧混跑必须保住）：用户在 Edge 开着时升级 Harbor，**旧 host 进程还
 *   活着** —— 它发的是 Phase 2 的裸 JSON（没有 id）。所以有 `id` → 新协议、回**帧**；
 *   否则 → 旧单向路径、回裸 JSON。判据只有一处（`P.isProtocolFrame`）。
 *
 * ★ 安全边界（如实写，别当成比实际更强）：Windows 命名管道 ACL 默认给创建者，但**同机
 *   同用户的其他进程仍可连上**，且能读到 data/ 下的 token。所以这层不是「隔离」，是
 *   **防误连 + 防冒充**（管道名带 data 根 hash + 消息必须带正确 token）。
 *
 * ⚠️ 本模块**不 require electron**；系统能力全部注入（自检才能不起 Electron 就测）。
 */

const net = require('node:net')
const P = require('./ext-protocol.cjs')
const { createOps } = require('./ext-ops.cjs')

/** 桥（单实例） */
function createBridge() {
  let server = null
  let token = ''
  let dataDir = ''
  /** 渲染层上报的「当前打开的会话」（见 handlers/ext.cjs 的 ext:activeSession） */
  let activeSessionId = ''
  /** @type {Record<string, any>} */
  const deps = { send: null, session: null, audit: null, wrap: null, log: null, chat: null }
  let ops = null
  /** 活着的连接（3a 起连接会保持，推送要能找到它们） */
  const socks = new Set()

  /** 兼容入口：处理一条消息，返回 Phase 2 的**拍平**形状（156 自检与裸 JSON 兜底都走它） */
  function ingest(message) {
    const res = ops.handle(String(message?.kind ?? ''), message)
    if (!res.ok) return { ok: false, error: res.error.message }
    return { ok: true, ...res.data }
  }

  /** 写一帧（或一段裸 JSON）。写失败只记一行 —— 对面可能已经关了连接 */
  function write(socket, out, framed) {
    try {
      socket.write(framed ? P.encodeFrame(out) : JSON.stringify(out))
    } catch (error) {
      deps.log?.warn?.(`扩展通道：回写失败（${error instanceof Error ? error.message : error}）`)
    }
  }

  /** 处理**一帧**：token 校验 → 分派 → 回写 */
  function respond(socket, message) {
    const framed = P.isProtocolFrame(message)

    if (!token || message?.token !== token) {
      deps.log?.warn?.('扩展通道：一条消息 token 不对，已拒')
      write(
        socket,
        framed
          ? P.failure({
              id: message.id,
              kind: message.kind,
              code: P.ERR.BAD_TOKEN,
              message: '通道校验失败 —— 重启 Harbor 再试',
            })
          : { ok: false, error: 'token 不对（消息不是本机这次启动的 Harbor 发的？）' },
        framed,
      )
      return
    }

    if (framed) {
      const res = ops.handle(message.kind, message.payload)
      write(
        socket,
        res.ok
          ? P.reply({ id: message.id, kind: message.kind, payload: res.data })
          : P.failure({ id: message.id, kind: message.kind, code: res.error.code, message: res.error.message }),
        true,
      )
      return
    }

    /* 旧单向路径（Phase 2 的 host 还活着时）—— 回裸 JSON，形状与当年一致 */
    const res = ops.handle(message?.kind, message)
    write(socket, res.ok ? { ok: true, ...res.data } : { ok: false, error: res.error.message }, false)
  }

  function onConnection(socket) {
    socks.add(socket)
    /* 帧是**流**：半帧要留着、粘包要切开 —— 所以累积到缓冲里增量解 */
    /** @type {Buffer} */
    let buf = Buffer.alloc(0)
    /** 这条连接是不是旧 host 的**裸 JSON**（见下面 data 里那段判据） */
    let legacy = false

    const drop = () => {
      socks.delete(socket)
      try {
        socket.destroy()
      } catch {
        /* 已经断了 */
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      /* 已判为旧 host 的裸 JSON → 攒着，等 end 整块收（旧 host 写一次就关连接） */
      if (legacy) return

      const { messages, rest, errors, fatal } = P.decodeFrames(buf, { max: P.MAX_PIPE_FRAME })
      /*
       * ★ 裸 JSON 兜底（旧 host → 新主进程，§6.1 组合矩阵里必须保住的那一格）。
       *
       * 旧 host 发的是**裸 JSON**、没有长度前缀。它的第一个字节一定是 `{`（0x7b），
       * 被当成帧头解出来就是荒谬长度 —— 实测 `{"t` → 小端 1,869,881,979 → `fatal`。
       * 所以「`fatal` + 首字节 `{`」就是它的判据；**判成裸 JSON 后绝不能 drop** ——
       * 那是一条完全有效的旧客户端（它在 Edge 开着时活得好好的）。
       *
       * 为什么这个判据够精确：我们的真帧长度低字节碰巧是 0x7b 的概率是 1/256，
       * 而还要同时 > 2 MB 才 fatal —— 两个条件叠起来实际不可能。
       */
      if (fatal && buf.length > 0 && buf[0] === 0x7b) {
        legacy = true
        deps.log?.warn?.('扩展通道：识别为旧版 host 的裸 JSON 连接（走兜底路径）')
        return
      }

      buf = rest
      for (const e of errors) deps.log?.warn?.(`扩展通道：丢弃一帧（${e}）`)
      for (const m of messages) respond(socket, m)
      if (fatal) {
        deps.log?.warn?.('扩展通道：协议失去同步，断开这条连接')
        drop()
      }
    })

    socket.on('error', drop)
    socket.on('close', () => socks.delete(socket))
    socket.on('end', () => {
      socks.delete(socket)
      if (!legacy) return
      try {
        /* 旧 host 的整条消息就在这块里 —— 形状与 Phase 2 完全一致 */
        respond(socket, JSON.parse(buf.toString('utf8')))
      } catch (error) {
        deps.log?.warn?.(`扩展通道：裸 JSON 解不开（${error instanceof Error ? error.message : error}）`)
      }
    })
  }

  return {
    /**
     * 起管道服务器。
     *
     * `send` / `wrap` 的签名要**写精确**（不能写 `Function`）：`createOps` 那边
     * 按具体签名声明依赖，宽类型赋不进去（`tsc` 会报 TS2322，内核类型检查会红）。
     *
     * @param {{
     *   dataDir: string,
     *   send: (name: string, payload: object) => void,
     *   session: object,
     *   audit: object,
     *   wrap: (input: { url?: string, title?: string, text?: string, truncated?: boolean, source?: string }) => string,
     *   log: object,
     *   chat?: { handleSend: Function, handleResume: Function, handleSelect: Function,
     *     handleNew: Function, handleAbort: Function, handleRegenerate: Function, noteActiveSession: Function },
     *   command?: { handleResult: Function },
     * }} options
     */
    start(options) {
      dataDir = String(options.dataDir ?? '')
      deps.send = options.send
      deps.session = options.session
      deps.audit = options.audit
      deps.wrap = options.wrap
      deps.log = options.log
      /* ★ 必须赋给 deps：setActiveSession 要拿它 noteActiveSession（漏了会 `?.` 静默短路 —— 真机逮到过） */
      deps.chat = options.chat ?? null

      ops = createOps({
        session: options.session,
        audit: options.audit,
        wrap: options.wrap,
        send: options.send,
        getActiveSession: () => activeSessionId,
        /* 2026-10-20：侧边栏自己选中的那条 —— 「读当前页 / 观察」落进它，而不是主窗口那条。
           闭包里读 deps.chat，所以 ext-chat 装着之后一直取到最新值。 */
        getSelectedSession: () => String(deps.chat?.selectedOf?.() ?? ''),
        chat: options.chat ?? null, /* 3b：侧边栏发消息那条路（装配处注入） */
        command: options.command ?? null, /* M04：下行指令的回执配对 */
      })

      token = P.writeToken(dataDir)
      if (!token) {
        deps.log?.warn?.('扩展桥：token 写不进去，桥已禁用（fail-closed）')
        return { ok: false, error: 'token 写入失败' }
      }

      const name = P.pipeName(dataDir)
      server = net.createServer(onConnection)
      server.on('error', (error) => {
        deps.log?.warn?.(`扩展桥：管道服务器出错：${error instanceof Error ? error.message : error}`)
      })
      server.listen(name, () => {
        deps.log?.info?.(`扩展桥已就绪：${name}`)
      })
      return { ok: true, name }
    },

    /** 渲染层上报当前打开的会话（切会话时调） */
    setActiveSession(id) {
      activeSessionId = String(id ?? '')
      /*
       * Phase 3c：侧边栏那套「在看哪条」跟着渲染层的上报学（见 setActiveSession）。
       * 必须在**这一刻**学：新建的会话在渲染层那边先是 `pending_…`，建好磁盘文件后
       * 会换成 `sess_…` 并重报；不学就留着一个作废 id，侧边栏下一条消息会发丢。
       */
      try {
        deps.chat?.noteActiveSession?.(activeSessionId)
      } catch (error) {
        /* 纯旁路：学不到只是侧边栏跟错，不能让正常上报失败 */
        deps.log?.warn?.(`扩展桥：同步侧边栏选中失败（${error instanceof Error ? error.message : error}）`)
      }
      return { ok: true }
    },

    /** 当前会话 id（自检用） */
    getActiveSession() {
      return activeSessionId
    },

    /** 管道上活着的连接数（自检 / 诊断 / 验收用）—— 「推不动」时第一个该看的就是它 */
    connectionCount() {
      return socks.size
    },

    /** 收一条消息（自检直接调，不必起管道） */
    ingest,

    /** 主动推送（流式分片用）。推送帧**没有 id** —— 与应答的区别就在这儿 */
    push(kind, payload) {
      const frame = P.encodeFrame(P.push({ kind, payload }))
      let sent = 0
      for (const s of socks) {
        try {
          s.write(frame)
          sent += 1
        } catch {
          /* 单条连接写失败不该影响别的 */
        }
      }
      return { ok: true, sent, connections: socks.size }
    },

    /** 操作结果落盘（M04-2）：调到 `ops` 那唯一一份实现（`ext-command` 只拿注入的 `land`，
     *  两个内核模块不互相 require —— 自检才能单独跑） */
    landAction(kind, result, meta) {
      try {
        return (ops && ops.ingestAction(kind, result, meta)) || {}
      } catch (error) {
        deps.log?.warn?.(`操作结果落盘失败：${error instanceof Error ? error.message : error}`)
        return {}
      }
    },

    stop() {
      for (const s of socks) {
        try {
          s.destroy()
        } catch {
          /* 忽略 */
        }
      }
      socks.clear()
      try {
        server?.close()
      } catch {
        /* 关不掉也无所谓，进程要退了 */
      }
      server = null
    },
  }
}

module.exports = {
  /* 管道名与 token 的**真相源**在 ext-protocol.cjs；这里转出来给老引用（自检）用 */
  PIPE_PREFIX: P.PIPE_PREFIX,
  TOKEN_FILE: P.TOKEN_FILE,
  MAX_MESSAGE: P.MAX_PIPE_FRAME,
  pipeName: P.pipeName,
  tokenPath: P.tokenPath,
  writeToken: P.writeToken,
  readToken: P.readToken,
  createBridge,
}
