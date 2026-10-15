/**
 * Native host —— 浏览器扩展（Edge）与 Harbor 之间的 stdio 帧协议
 *
 * ── 它是什么 ─────────────────────────────────────────────────
 *
 * Edge 扩展调 `chrome.runtime.connectNative('com.harbor.agent')` 时，浏览器会
 * **另起一个进程**（清单里 `path` 指向的那个），用 stdin / stdout 传 JSON。
 * 那个进程就是这里 —— Harbor.exe 被 Edge 用 `--parent-window=…` 拉起时，
 * `main.cjs` 在最早期把控制权交给本模块（见那边的分支）。
 *
 * ── 为什么判据是 `--parent-window=`（而不是自造一个开关）──
 *
 * Phase 0 实测（docs/research/edge-extension-phase0-report.md）：
 *   · 宿主清单的 `path` **只能是一个不带参数的可执行文件** ——
 *     写成 `Harbor.exe --native-host` 这种形态，Edge 会把整串当成**文件路径**，
 *     直接报 "Specified native messaging host not found."。
 *   · 所以只能用 Harbor.exe 本体，靠 **Edge 自己传进来的参数**认身份。
 *   · 实测 argv：`[exe] ["chrome-extension://<id>/"] ["--parent-window=0"]`
 *     `—parent-window=`` 在 node.exe 与 Electron 下都**原样传递**（origin 会被
 *     node 的路径解析弄坏，所以不用它当判据）。
 *
 * ── 为什么 run() 是**同步阻塞**的循环（而不是事件流）──────
 *
 * 两个原因，缺一不可：
 *
 *   ① **CJS 的顶层 `return` 在 Node 合法、`tsc` 不认**（TS1108）。而 host 分支
 *      必须「跑完就别再往下走」—— 用 `run()` **永不返回**来实现，最自然。
 *      真机上实测过 `fs.readSync(0, …)` 在 Windows **管道**上可用。
 *   ② 同步循环顺带消掉一整类隐患：事件驱动下 `run()` 返回后事件循环还在转，
 *      后面那些 `app.whenReady()` / 建窗口的代码就可能被触发；同步阻塞下它们
 *      **根本没机会执行**。
 *
 * ── ★ stdout 是协议通道，一个字节的杂音都不行 ──────────────
 *
 * `core/log.cjs` 在非 production 下会 `console.log()` —— 直通 stdout。
 * 一旦 host 模式下调了 `log.info()`，Edge 读到的就是半截帧头，协议当场崩。
 * 所以 `run()` 第一件事就是**把 console.log 改道到 stderr**。
 * 这条不是洁癖：它是最容易在 Phase 1b「顺手加一句日志」时踩响的雷。
 *
 * ── 白名单：只碰「顶层不 require electron」的模块 ────────────
 *
 * Phase 0 §4 逐个 require 验证过下面 15 个模块在**纯 Node** 里能安全加载。
 * ⚠️ 但 `handlers/browser.cjs` 那种**顶层解构 electron** 的模块不行 ——
 * 它在 Node 里「能加载但拿到的是 undefined」，用起来才炸（Phase 0 实测）。
 * 所以白名单是一份**限定**，不是「随便 require 都行」。
 *
 * ★ Phase 1a 只做协议本身（ping / pong），**不加载**这些模块（零副作用）。
 *   白名单在这里定义 + 由自检组 154 钉住，Phase 1b 接业务时从这里取。
 */

const fs = require('node:fs')

/** Edge 拉起 host 时一定会带的参数 —— 身份判据 */
const HOST_FLAG = '--parent-window='

/**
 * 单条消息上限。
 *
 * 官方：host → Edge **1 MB**；Edge → host 4 GB。这里取 1 MB 当**双向**上限 ——
 * 我们这边不该收到巨型帧，真收到了说明对面不是我们的扩展，断开比硬扛安全。
 */
const MAX_FRAME = 1024 * 1024

/** 白名单：Phase 0 §4 验证过的 15 个「顶层不 require electron」的模块（相对 electron/） */
const SAFE_MODULES = [
  'core/paths.cjs',
  'core/log.cjs',
  'core/config.cjs',
  'core/config-defaults.cjs',
  'core/capability.cjs',
  'core/webview-permissions.cjs',
  'core/browser-identity.cjs',
  'core/audit.cjs',
  'core/risk.cjs',
  'core/redact.cjs',
  'core/tools/registry.cjs',
  'core/tools/index.cjs',
  'core/session.cjs',
  'core/chat-emit.cjs',
  'core/browse-read.cjs',
]

/* ══════════════════════════════════════════════════════════════
   帧编解码 —— 纯函数，不碰流（所以自检能在纯 Node 里直接跑）
   ══════════════════════════════════════════════════════════════ */

/**
 * 把一条消息编成一帧：**4 字节小端长度 + UTF-8 JSON 体**。
 *
 * @param {unknown} message
 * @returns {Buffer}
 */
function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message) ?? 'null', 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/**
 * 从字节流里切出**尽可能多的完整帧**。
 *
 * 为什么是增量式的：stdin 的 `data` 事件**不保证一次给一整帧** ——
 * 可能半帧（等下一块）、也可能一次给三帧（粘包）。所以调用方把没吃完的
 * 尾巴留着，下次接在前面。
 *
 * @param {Buffer} buf 累积的字节
 * @param {{ max?: number }} [opts]
 * @returns {{ messages: unknown[], rest: Buffer, errors: string[], fatal: boolean }}
 *   `fatal` = 帧头声明了一个不可能的长度（协议已经没法对齐了，只能断）
 */
function decodeFrames(buf, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_FRAME
  const messages = []
  const errors = []
  let offset = 0
  let fatal = false

  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? [])

  while (data.length - offset >= 4) {
    const len = data.readUInt32LE(offset)
    if (len > max) {
      /* 长度离谱：再往后读也没法对齐（不知道真实边界在哪），只能断 */
      errors.push(`帧长 ${len} 超过上限 ${max}`)
      fatal = true
      offset = data.length
      break
    }
    /* 半帧：留着等下一块，不要提前消费 */
    if (data.length - offset - 4 < len) break

    const body = data.subarray(offset + 4, offset + 4 + len)
    offset += 4 + len
    try {
      messages.push(JSON.parse(body.toString('utf8')))
    } catch (error) {
      errors.push(`帧体不是 JSON：${error instanceof Error ? error.message : error}`)
    }
  }

  return { messages, rest: data.subarray(offset), errors, fatal }
}

/**
 * 这一轮启动是不是「被浏览器拉起的 native host」。
 *
 * @param {string[]} [argv]
 * @returns {boolean} 含 `--parent-window=` 就算 —— **空值也算**
 *   （Edge 在 service worker 上下文里传的就是 `--parent-window=0`；
 *    官方也提醒过这个值不保证有内容，所以只判「参数在不在」）。
 */
function isHostArgv(argv = process.argv) {
  return Array.isArray(argv) && argv.some((a) => typeof a === 'string' && a.startsWith(HOST_FLAG))
}

/**
 * 一条消息该回什么。Phase 1a 只有 ping/pong（协议最小验证）。
 *
 * @param {unknown} message
 * @returns {object}
 */
function handleMessage(message) {
  if (message && typeof message === 'object' && 'ping' in message) {
    return { pong: 1, echo: message }
  }
  return { error: 'Phase 1a 只认 {"ping":…}', echo: message ?? null }
}

/* ══════════════════════════════════════════════════════════════
   跑起来
   ══════════════════════════════════════════════════════════════ */

/** host 模式下的状态行 —— 走 stderr（stdout 是协议通道，不能碰） */
function note(text) {
  try {
    process.stderr.write(`[native-host] ${text}\n`)
  } catch {
    /* stderr 都写不进去就算了，不能因为记日志把协议弄挂 */
  }
}

/** 一次同步读的块大小（读完再解帧，半帧留到下一轮） */
const READ_CHUNK = 64 * 1024

/**
 * 进入 stdio 帧循环。**永不返回** —— 要么在 `for (;;)` 里转，要么 `process.exit(0)`。
 *
 * ⚠️ ★ **绝不能改成 `return`**（这是本模块最容易犯的错，Phase 1a 真机逮到过一次）：
 *   顶层 `return` 会撞 tsc 的 TS1108（CJS 顶层 return 在 Node 合法、TS 不认），
 *   所以 `main.cjs` 那边写的是 `if (isHostArgv()) run()` —— 没有 return 也没 else。
 *   在这种写法下，`run()` 一旦 `return`，**main.cjs 后面的代码就会继续执行**
 *   （抢单实例锁、建窗口、装 IPC…）—— host 模式当场变成"开一个窗口"。
 *   真机现象：Edge 拉起的进程带着 `--parent-window=0`，却建出了窗口 + 托盘 + 4 个子进程。
 *   → 所以收尾一律用 `process.exit(0)`（同步写已落盘，不会截断帧）。
 *
 * 为什么同步读：真机实测 `fs.readSync(0, …)` 在 Windows **管道**上可用。
 * 副作用是「读帧」这件事不依赖事件循环 —— 对 host 是好事（除协议外什么都不干）。
 */
function run() {
  /*
   * ★ 先把 console.log 改道到 stderr。
   *
   * `core/log.cjs` 的 info 会 console.log —— 那是 stdout，就是协议通道。
   * 改道之后，**任何**模块（含白名单里将来要接的那 15 个）顺手打日志都不会
   * 污染帧。这一行是整个模块的保命线，别删。
   */
  console.log = (...args) => console.error(...args)

  note(`已就绪（pid=${process.pid}）`)

  /*
   * ★ 显式标注 `Buffer`（不带泛型）—— 不是啰嗦：
   *   新版 @types/node 里 `Buffer.alloc(0)` 是 `Buffer<ArrayBuffer>`、而
   *   `Buffer.concat(...)` 返回 `Buffer<ArrayBufferLike>`，两者赋值会报 TS2322。
   *   裸 `Buffer` 的默认泛型参数就是 ArrayBufferLike，两边都装得下。
   */
  /** @type {Buffer} */
  let buf = Buffer.alloc(0)

  for (;;) {
    const chunk = Buffer.alloc(READ_CHUNK)
    let got = 0
    try {
      got = fs.readSync(0, chunk, 0, chunk.length, null)
    } catch (error) {
      note(`stdin 读失败：${error instanceof Error ? error.message : error}`)
      process.exit(0)
    }
    /*
     * EOF / 协议失步都**直接退出进程**，绝不 `return` ——
     * return 会让 main.cjs 继续往下建窗口（见本函数头部的 ⚠️）。
     * fs.writeSync 是同步的，已写出去的帧不会因为 exit 被截断。
     */
    if (got === 0) process.exit(0)

    buf = Buffer.concat([buf, chunk.subarray(0, got)])
    const { messages, rest, errors, fatal } = decodeFrames(buf)
    buf = rest

    for (const err of errors) note(`丢弃一帧：${err}`)

    for (const message of messages) {
      try {
        fs.writeSync(1, encodeFrame(handleMessage(message)))
      } catch (error) {
        note(`回帧失败：${error instanceof Error ? error.message : error}`)
      }
    }

    /* 帧头已经不可能对齐 —— 断掉比继续读安全（Edge 会走 onDisconnect） */
    if (fatal) {
      note('协议失去同步，退出')
      process.exit(0)
    }
  }
}

/* 直接跑这个文件时也进 host 循环（方便手测 / 自检用子进程喂帧） */
if (require.main === module) run()

module.exports = {
  HOST_FLAG,
  MAX_FRAME,
  SAFE_MODULES,
  encodeFrame,
  decodeFrames,
  isHostArgv,
  handleMessage,
  run,
}
