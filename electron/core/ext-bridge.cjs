/**
 * 浏览器扩展 ↔ Harbor 主进程的桥（Phase 2）
 *
 * ── 它解决什么 ───────────────────────────────────────────────
 *
 * Edge 拉起的 native host 是**另一个进程**（见 native-host.cjs），拿不到主进程的
 * 内存态（会话、审计、当前打开的对话）。而「读当前页」的结果必须落进 Harbor 的
 * 会话里 —— 所以 host 需要一条路把消息**送回主进程**。
 *
 * 用户拍板走**命名管道**（`\\.\pipe\...`）：host 侧 `fs.writeFileSync(pipe, …)`
 * 同步写（实测可行，见 tmp 探针），主进程侧 `net.createServer` 收。
 *
 * ── 两个必须记住的实测事实 ───────────────────────────────────
 *
 *   ① **管道不监听时 write 立刻抛 ENOENT**（不阻塞）→ host 侧据此判
 *      「Harbor 没在运行」，回给扩展一条人话错误，而不是干等。
 *   ② `writeFileSync` 到管道是「打开→写→关」→ **一次连接 = 一条消息**，
 *      所以主进程按「连接结束」切分，不必自己搞长度前缀。
 *
 * ── 安全边界（如实写，别当成比实际更强）──────────────────────
 *
 * Windows 命名管道的 ACL 默认给创建者，但**同机同用户的其他进程仍可连上**，
 * 且能读到 data/ 下的 token 文件。所以这层不是「隔离」，是**防误连 + 防冒充**：
 *   · 管道名带 data 根路径的 hash（不同安装互不干扰、不易猜）
 *   · 消息必须带正确 token（主进程每次启动重新生成）
 * 要更强的隔离得设 Win32 管道 ACL —— Node 没有内置 API，本阶段不做（已记入报告）。
 *
 * ⚠️ 本模块**不 require electron**（host 进程要 require 它拿 pipeName 这个
 *    唯一真相源 —— 见硬约束 #9：跨模块口径只能有一处定义）。所有系统能力注入。
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

/** 管道名前缀。Windows 命名管道的固定前缀，改不了。 */
const PIPE_PREFIX = '\\\\.\\pipe\\harbor-ext-'

/** token 文件名（落在 data/ 下，与 path 硬约束一致） */
const TOKEN_FILE = 'ext-bridge.token'

/**
 * 单条消息上限（2 MB）。
 *
 * 页面正文在扩展侧已截断到 512 KB（见扩展的 MAX_TEXT），包装后也不会超过 1 MB。
 * 这里留 2 MB 余量；超了就断开 —— 对面不是我们的扩展。
 */
const MAX_MESSAGE = 2 * 1024 * 1024

/**
 * 管道名 —— **唯一真相源**（host 与主进程都必须用这个函数算）。
 *
 * 为什么带 hash：同一台机器上可能有多个 Harbor 安装（不同 data 根），
 * 固定名字会互相串台。用 data 根路径的 hash 区分。
 *
 * @param {string} dataDir 数据根目录
 * @returns {string}
 */
function pipeName(dataDir) {
  const hash = crypto.createHash('sha1').update(String(dataDir ?? '')).digest('hex').slice(0, 12)
  return `${PIPE_PREFIX}${hash}`
}

/** token 文件路径 */
function tokenPath(dataDir) {
  return path.join(String(dataDir ?? ''), TOKEN_FILE)
}

/**
 * 生成并写入本次启动的 token（每次启动都换，旧 token 立即失效）。
 *
 * @param {string} dataDir
 * @returns {string} 生成的 token（写不进去就返回空串 → 桥会拒绝一切消息，fail-closed）
 */
function writeToken(dataDir) {
  const token = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    /* mode 在 Windows 上被忽略，写上是为了在别的平台上也是对的 */
    fs.writeFileSync(tokenPath(dataDir), token, { encoding: 'utf8', mode: 0o600 })
    return token
  } catch {
    return ''
  }
}

/** 读 token（host 侧用；读不到返回空串） */
function readToken(dataDir) {
  try {
    return fs.readFileSync(tokenPath(dataDir), 'utf8').trim()
  } catch {
    return ''
  }
}

/* ══════════════════════════════════════════════════════════════
   主进程侧：管道服务器
   ══════════════════════════════════════════════════════════════ */

/** 桥的状态（单实例） */
function createBridge() {
  let server = null
  let token = ''
  let dataDir = ''
  /** 渲染层上报的「当前打开的会话」（见 handlers/ext.cjs 的 ext:activeSession） */
  let activeSessionId = ''
  const deps = { send: null, session: null, audit: null, wrap: null, log: null }

  /**
   * 处理一条来自 host 的消息。
   *
   * 目前只有 `ext:page`（Phase 2）。返回给 host 的结果会原样转给扩展。
   *
   * @param {object} message
   * @returns {{ ok: boolean, error?: string, sessionId?: string, chars?: number, created?: boolean }}
   */
  function ingest(message) {
    const kind = String(message?.kind ?? '')
    if (kind !== 'ext:page') return { ok: false, error: `不认识的消息类型：${kind || '(空)'}` }

    const url = String(message.url ?? '')
    const title = String(message.title ?? '')
    const text = String(message.text ?? '')
    const truncated = message.truncated === true

    /* ★ 包装是**安全职责**，必须做，且只做一次（和 browse 工具同一份实现） */
    const wrapped = deps.wrap({ url, title, text, truncated })

    /* 决定落进哪条会话：优先「界面当前打开的那条」，否则新建一条专用会话 */
    let sessionId = activeSessionId
    let created = false
    /*
     * ★ 判「这条会话还在不在」必须**容错** —— `session.load` 对非法 id 会**抛**
     *   （session-io.cjs 校验 `sess_` 前缀）。自检真逮到过：渲染层报来一个怪 id，
     *   异常从 ingest 冒到 socket 层，被那个 catch 兜成「消息不是合法 JSON」——
     *   于是**页面内容静默丢掉，用户还看到一条误导的错**。
     *   所以：id 不合法、会话被删、读坏了 —— 一律当「没有当前会话」，走兜底新建。
     */
    const alive = (id) => {
      if (!id) return false
      try {
        return Boolean(deps.session.load(id).meta)
      } catch {
        return false
      }
    }
    if (!alive(sessionId)) {
      const meta = deps.session.create({ title: `浏览器：${title || url || '未命名页面'}`, mode: 'pair' })
      sessionId = meta.id
      created = true
    }

    const ok = deps.session.append(sessionId, {
      role: 'user',
      content: wrapped,
      ts: Date.now(),
      /* 标出这条不是用户手打的 —— 界面可以据此区别显示 */
      source: 'extension',
    })

    deps.audit.record({
      sessionId,
      tool: 'ext:page',
      ok: ok.ok !== false,
      extras: { source: 'extension', url, title, chars: text.length, truncated, createdSession: created },
    })

    deps.send('ext:page', { sessionId, url, title, chars: text.length, created, truncated })

    return { ok: true, sessionId, chars: text.length, created }
  }

  function onConnection(socket) {
    const chunks = []
    let size = 0
    let dead = false

    socket.on('data', (buf) => {
      size += buf.length
      if (size > MAX_MESSAGE) {
        dead = true
        socket.destroy()
        return
      }
      chunks.push(buf)
    })

    socket.on('error', () => socket.destroy())

    /* 一次连接 = 一条消息（见文件头 ②），所以 end 才是完整的消息边界 */
    socket.on('end', () => {
      if (dead) return
      /** @type {{ ok: boolean, error?: string, sessionId?: string, chars?: number, created?: boolean }} */
      let reply = { ok: false, error: '空消息' }
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!token || message?.token !== token) {
          reply = { ok: false, error: 'token 不对（消息不是本机这次启动的 Harbor 发的？）' }
        } else {
          reply = ingest(message)
        }
      } catch (error) {
        reply = { ok: false, error: `消息不是合法 JSON：${error instanceof Error ? error.message : error}` }
      }
      try {
        /*
         * ★ 写回复 —— 但**当前没人读它**，如实写在这里免得后人误解：
         *   host 用的是 `fs.writeFileSync(pipe, …)`（打开→写→关），写完连接就关了，
         *   读不到这个回复（探针实测：`sock.end()` 之后服务器再 write，客户端收不到）。
         *   所以对 host 而言，`delivered=true` 只等于「字节已经写进管道」，
         *   **不等于**「主进程已经处理成功」—— 这一点在扩展的文案里如实标了。
         *   留着它是因为：如果将来 host 改成「写完不关、同步读回复」，这里就现成了。
         */
        socket.write(JSON.stringify(reply))
      } catch {
        /* host 那边已经关了 —— 这正是常态，不是错误 */
      }
    })
  }

  return {
    /**
     * 起管道服务器。
     *
     * @param {{ dataDir: string, send: Function, session: object, audit: object, wrap: Function, log: object }} options
     */
    start(options) {
      dataDir = String(options.dataDir ?? '')
      deps.send = options.send
      deps.session = options.session
      deps.audit = options.audit
      deps.wrap = options.wrap
      deps.log = options.log

      token = writeToken(dataDir)
      if (!token) {
        deps.log?.warn?.('扩展桥：token 写不进去，桥已禁用（fail-closed）')
        return { ok: false, error: 'token 写入失败' }
      }

      const name = pipeName(dataDir)
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
      return { ok: true }
    },

    /** 当前会话 id（自检用） */
    getActiveSession() {
      return activeSessionId
    },

    /** 收一条消息（自检直接调，不必起管道） */
    ingest,

    stop() {
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
  PIPE_PREFIX,
  TOKEN_FILE,
  MAX_MESSAGE,
  pipeName,
  tokenPath,
  writeToken,
  readToken,
  createBridge,
}
