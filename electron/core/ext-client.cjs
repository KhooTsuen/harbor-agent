/**
 * host 侧：与 Harbor 主进程的通道客户端（Phase 3a）
 *
 * ── 它取代了谁 ───────────────────────────────────────────────
 *
 * 取代 `ext-forward.cjs`（已删）。那个模块的前提是「**单向写、不等回复**」，
 * 而 Phase 3a 起 host 要「问一句、等回话」——前提不成立，逻辑并到这里。
 *
 * ── 两块能力，给两个不同的驱动用 ─────────────────────────────
 *
 *   · `createClient()` —— **双向**（Phase 3a 主线）：懒连接、保持、按 id 匹配应答、
 *     超时、断线重连。事件驱动的 `runInteractive()` 用它。
 *   · `forwardPage()`  —— **单向同步写**（兼容形态保底）：`run()` 是同步阻塞循环
 *     （承重墙，见 native-host.cjs 文件头），`await` 不了任何异步 —— 所以它只能
 *     沿用「打开→写→关、不等回复」。真机上这条形态本就跑不通（Chromium 的 CRLF
 *     会污染 stdout），留着是退路。**新功能一律别用它。**
 *
 * ⚠️ 本模块**不 require electron**（host 进程要 require 它）。
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const P = require('./ext-protocol.cjs')

/** 数据根的环境变量名（由 harbor-host.cmd 用 %~dp0 传入）—— 真相源在协议模块 */
const DATA_ENV = P.DATA_ENV

/**
 * host 进程的数据根。
 *
 * ⚠️ 不能直接用 `core/paths.cjs`：它的 `rootDir()` 依赖 `markPackaged()`
 *    （由 main.cjs 调），而**路径 2 下 main.cjs 根本不执行** —— 那就回落到
 *    「electron/ 上两级」= `resources/app`，整个 data 根都错了。
 *    所以：环境变量优先（.cmd 里用 %~dp0 传，最明确），拿不到再按 exe 位置推。
 *
 * @returns {string}
 */
function hostDataDir() {
  const fromEnv = String(process.env[DATA_ENV] ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    /* 打包版回退：<exe 同级>/data —— 与 core/paths.cjs 的口径一致 */
    return path.join(path.dirname(process.execPath), 'data')
  } catch {
    return ''
  }
}

/* ══════════════════════════════════════════════════════════════
   ① 单向同步写（**只给 run() 这个兼容形态的遗留驱动用**）
   ══════════════════════════════════════════════════════════════ */

/**
 * 同步把一条消息写进管道，**不等回复**（`fs.writeFileSync` 是「打开→写→关」）。
 *
 * ★ 语义如实说清：返回的 `ok:true` 只表示「**字节成功写进了管道**」，
 *   **不表示主进程已经落进会话**。Phase 2 的扩展文案按这个口径写。
 *   Phase 3a 起主线走 `createClient()`（那才是真回执）—— 本函数只是 `run()` 的保底。
 *
 * @param {string} kind
 * @param {Record<string, unknown>} payload
 * @returns {{ ok: boolean, delivered: boolean, error?: string }}
 */
function writeOnceSync(kind, payload) {
  const dataDir = hostDataDir()
  if (!dataDir) return { ok: false, delivered: false, error: '定位不到 Harbor 的数据目录' }

  const body = P.request({ id: `s-${Date.now().toString(36)}`, kind, payload, token: P.readToken(dataDir) })
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  if (bytes.length > P.MAX_PIPE_FRAME) {
    return { ok: false, delivered: false, error: '内容太大，超出单条消息上限' }
  }

  try {
    fs.writeFileSync(P.pipeName(dataDir), bytes)
    return { ok: true, delivered: true }
  } catch (error) {
    const code = error && error.code
    /* ★ 管道不监听时立刻抛 ENOENT（不阻塞）—— 正好用来判「Harbor 没在运行」 */
    const hint =
      code === 'ENOENT'
        ? 'Harbor 没有在运行（或扩展通道没安装）'
        : `${code || ''} ${error instanceof Error ? error.message : error}`.trim()
    return { ok: false, delivered: false, error: hint }
  }
}

/**
 * 兼容形态（`run()`）的 `ext:page` 处理 —— 形状与 Phase 2 完全一致。
 *
 * @param {Record<string, unknown> | null | undefined} message
 * @returns {{ type: string, ok: boolean, chars: number, delivered: boolean, error?: string }}
 */
function forwardPage(message) {
  const text = String(message?.text ?? '')
  const res = writeOnceSync(P.KIND.EXT_PAGE, {
    url: String(message?.url ?? ''),
    title: String(message?.title ?? ''),
    text,
    truncated: message?.truncated === true,
  })
  return { type: 'ext:page.result', ok: res.ok, chars: text.length, delivered: res.delivered, error: res.error }
}

/* ══════════════════════════════════════════════════════════════
   ② 双向客户端（Phase 3a 主线）
   ══════════════════════════════════════════════════════════════ */

/**
 * 建一个与主进程的通道客户端。
 *
 * 连接策略：**懒连**（第一次 request 才连）——「Harbor 没开」因此每次请求都能
 * **立刻**知道（ENOENT 不阻塞），比启动就连（失败变成进程启动期的静默错误）好诊断。
 * 连上后**保持**；断了下次请求自动重连。
 *
 * @param {{ dataDir?: string, timeoutMs?: number, log?: { warn?: (m: string) => void } }} [options]
 */
function createClient(options = {}) {
  const dataDir = String(options.dataDir ?? hostDataDir())
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : P.HOST_TIMEOUT_MS
  const warn = options.log?.warn ?? (() => {})

  let socket = null
  let connecting = null
  /** @type {Buffer} */ /* 显式标注：`alloc` 与 `concat` 的泛型参数不同，见 native-host.cjs 同一处注释 */
  let buf = Buffer.alloc(0)
  let seq = 0
  /** @type {Map<string, { resolve: (v: object) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  let pushHandler = null

  /** 在途请求全清 —— 每条都回一条带 code 的人话（不让扩展干等） */
  function settleAll(code, message) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: { code, message } })
    }
    pending.clear()
  }

  /** 断开：清 socket、清缓冲、把在途请求全部结掉 */
  function drop(reason) {
    if (socket) {
      try {
        socket.destroy()
      } catch {
        /* 已经断了 */
      }
    }
    socket = null
    connecting = null
    buf = Buffer.alloc(0)
    if (pending.size) settleAll(P.ERR.NO_HARBOR, reason ?? 'Harbor 的连接断了')
  }

  function handleFrame(message) {
    if (P.isPush(message)) {
      if (pushHandler) pushHandler(message)
      return
    }
    if (!P.isReply(message)) return /* 不认识的形状：丢掉（不回、不炸） */
    const entry = pending.get(message.id)
    if (!entry) return /* 迟到的应答（已超时）—— 忽略 */
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk])
    const { messages, rest, errors, fatal } = P.decodeFrames(buf, { max: P.MAX_PIPE_FRAME })
    buf = rest
    for (const e of errors) warn(`丢弃一帧：${e}`)
    for (const m of messages) handleFrame(m)
    if (fatal) {
      warn('协议失去同步，断开连接')
      drop('Harbor 的连接坏了（协议失步）')
    }
  }

  function connect() {
    if (socket) return Promise.resolve(socket)
    if (connecting) return connecting
    connecting = new Promise((resolve, reject) => {
      const sock = net.connect(P.pipeName(dataDir))
      const onError = (error) => {
        connecting = null
        try {
          sock.destroy()
        } catch {
          /* 忽略 */
        }
        reject(error)
      }
      sock.once('error', onError)
      sock.once('connect', () => {
        sock.removeListener('error', onError)
        socket = sock
        connecting = null
        sock.on('data', onData)
        sock.on('error', (error) => drop(`Harbor 的连接出错：${error.message}`))
        sock.on('close', () => drop())
        resolve(sock)
      })
    })
    return connecting
  }

  /**
   * **主动连一次**（不等第一次 request）。
   *
   * ── ★ 为什么必须有这个（M04 真机逮到）────────────────────────
   *
   * 原来是**懒连**（第一次 request 才连管道）—— 那会儿只服务「扩展问、主进程答」。
   * M04 多了**反向**的用法：**主进程主动推指令**（click / verify）。而主进程要推，
   * 前提是管道上**有一条活着的连接** —— 扩展一次请求都没发过时，懒连就让连接不存在。
   *
   * 最直接的证据：M04-2 真机验收第一次跑，扩展刚连上 host、还没发过任何请求，
   * 主进程 `push` 直接拿到 `sent: 0` → 「浏览器扩展没连上」——**而浏览器好端端的**。
   *
   * ⚠️ 顺带说明：3b 的流式分片**一直**能用，只是因为那时用户已经点过发送
   *   （连接被那条消息激活了）。那是**巧合，不是设计**。这一改把它也坐实了。
   *
   * 连不上（Harbor 没开）不算错：**静默忽略**，等下次 request 或下次推送时再试。
   */
  function ensureConnected() {
    return connect().catch(() => null)
  }

  /**
   * 发一条请求，等主进程的应答。
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<{ ok: true, payload?: object } | { ok: false, error: { code: string, message: string } }>}
   */
  async function request(kind, payload) {
    let sock
    try {
      sock = await connect()
    } catch (error) {
      const code = error && error.code
      return {
        ok: false,
        error: {
          code: P.ERR.NO_HARBOR,
          message: code === 'ENOENT' ? 'Harbor 没有在运行（先启动 Harbor）' : `连不上 Harbor：${error.message}`,
        },
      }
    }

    const id = `h-${++seq}`
    let frame
    try {
      /* 管道上限 2 MB（与上面 `writeOnceSync` 同一口径）—— 超限**不发**，回一条能认出来的失败 */
      frame = P.encodeFrame(P.request({ id, kind, payload, token: P.readToken(dataDir) }), {
        max: P.MAX_PIPE_FRAME,
      })
    } catch (error) {
      if (!error || error.code !== P.FRAME_TOO_LARGE) throw error
      const tooBig = `这次请求序列化后 ${error.bytes} 字节，超过 Harbor 单条消息上限 ${P.MAX_PIPE_FRAME} —— 没有发出去。请减少一次发送的内容量。`
      return { ok: false, error: { code: P.ERR.INTERNAL, message: tooBig } }
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: { code: P.ERR.TIMEOUT, message: 'Harbor 没有响应（超时）' } })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      try {
        sock.write(frame)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, error: { code: P.ERR.NO_HARBOR, message: `写通道失败：${error.message}` } })
      }
    })
  }

  return {
    request,
    /** 主动连一次（M04：主进程要能主动推指令，不能等第一次请求才建连接） */
    ensureConnected,
    isConnected: () => Boolean(socket),
    /** 注册推送处理（3b 的流式分片用；3a 不调） */
    setPushHandler: (fn) => {
      pushHandler = typeof fn === 'function' ? fn : null
    },
    close: () => drop('客户端已关闭'),
  }
}

module.exports = { DATA_ENV, hostDataDir, writeOnceSync, forwardPage, createClient }
