/**
 * Native host —— 浏览器扩展（Edge）与 Harbor 之间的 stdio 帧协议
 *
 * ── 它是什么 ─────────────────────────────────────────────────
 *
 * Edge 扩展调 `chrome.runtime.connectNative('com.harbor.agent')` 时，浏览器会
 * **另起一个进程**（宿主清单 `path` 指向的那个），用 stdin / stdout 传 JSON。
 * 那个进程就是这里。
 *
 * ── 两种被拉起的形态（★ 路径 2 是当前首选）──────────────────
 *
 *   ★ **路径 2**：宿主清单 `path` 指向一个 **`.cmd` 包装器**，它设
 *     `ELECTRON_RUN_AS_NODE=1` 再调 `Harbor.exe <本文件>` —— Electron 二进制
 *     **以纯 Node 模式**跑本文件，`require.main === module` 直接进 `runInteractive()`。
 *     **这条路不经过 `main.cjs`。** 为什么必须绕开 Chromium：走 Chromium 初始化时
 *     启动期会往 stdout 写一个 `\r\n`，把帧头污染成荒谬长度 → Edge 报「通信错误」
 *     （本地 dump 原始字节锁定，见 docs/research/edge-extension-host-stdout-experiments.md）。
 *     纯 Node 模式下 stdout **一个杂音字节都没有**。
 *
 *   · **兼容形态**（保留）：Edge 直接拉 `Harbor.exe`（不经 .cmd），此时 argv 是
 *     `[exe] ["chrome-extension://<id>/"] ["--parent-window=0"]`，由 `main.cjs`
 *     在最早期调 `isHostArgv()` 认出来 —— 留给「将来 Edge 换拉起方式」当退路。
 *
 * ── 两个驱动（Phase 3a 起）──────────────────────────────────
 *
 *   ★ **路径 2（主线）** → `runInteractive()`（在 `core/ext-host-loop.cjs`）：
 *     **事件驱动**。双向要求同时等 stdin 与管道的回复，同步循环做不到。
 *   · **兼容形态（退路）** → `run()`（本文件）：同步阻塞、永不返回，见下。
 *     ⚠️ **新功能一律进 `runInteractive()`**，别再加到 `run()` 里。
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
 * ★ Phase 1a 只做协议本身（ping / pong）。Phase 2 起多了 `ext:page`（扩展读到的
 *   页面内容 → 转主进程）。**路径 2 下 main.cjs 不执行**，所以白名单暂时只是入口约束。
 */

const fs = require('node:fs')
/* Phase 3a：协议的唯一真相源（帧编解码 / 报文 / 错误码 / 管道名与 token），两侧共用同一份 */
const P = require('./core/ext-protocol.cjs')
/* Phase 2 起：把扩展送来的页面内容转给主进程（兼容形态的同步写；3a 又加了双向客户端） */
const { forwardPage } = require('./core/ext-client.cjs')

/** 兼容形态的判据：Edge 直接拉 Harbor.exe 时一定会带它 */
const HOST_FLAG = '--parent-window='

/** 路径 2 的判据：包装器设的「以纯 Node 模式跑」开关（Electron 官方环境变量） */
const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'

/*
 * 单条消息上限：**1 MB**（官方：host → Edge 1 MB）。值的**真相源**在
 * `core/ext-protocol.cjs`（两侧共用，不各写一个数）；这里转出来给自检/调用方用。
 */

/** 白名单：Phase 0 §4 验证过的「顶层不 require electron」的模块（相对 electron/） */
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
  /* Phase 2 起新增：扩展桥 + 通道（都不 require electron，自检会真加载一遍）。
     Phase 3a 把 ext-forward 换成了 ext-protocol / ext-client / ext-host-loop。 */
  'core/ext-protocol.cjs',
  'core/ext-client.cjs',
  'core/ext-host-loop.cjs',
  'core/ext-bridge.cjs',
]

/* ══════════════════════════════════════════════════════════════
   帧编解码 —— 实现已搬到 `core/ext-protocol.cjs`（两侧共用的唯一真相源）
   ══════════════════════════════════════════════════════════════ */

/* 这里只转出来给自己与调用方用；行为一字未改 */
const { encodeFrame, encodeFrameOrFallback, decodeFrames, MAX_FRAME } = P

/**
 * 这一轮启动是不是「被浏览器拉起的 native host」。
 *
 * 三种形态都认（按优先级）：
 *   ① 路径 2：`ELECTRON_RUN_AS_NODE=1` 且 argv 指着 `main.cjs`。
 *      ⚠️ 正常走路径 2 时本函数**不会被调用** —— `.cmd` 直接执行本文件，
 *      `require.main === module` 已经进了 `run()`。留着是防「用 Node 模式跑
 *      main.cjs」的误配（那时 main.cjs 的 `require('electron')` 解构出 undefined）。
 *   ② argv 里显式指着 `native-host.cjs`（手动指脚本 / 包装器的其他写法）。
 *   ③ 兼容：`--parent-window=`（Edge 直接拉 Harbor.exe 的形态）。空值也算 ——
 *      service worker 上下文里传的就是 `--parent-window=0`，官方说过值不保证有内容。
 *
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function isHostArgv(argv = process.argv, env = process.env) {
  if (!Array.isArray(argv)) return false
  const some = (test) => argv.some((a) => typeof a === 'string' && test(a))
  if (env?.[RUN_AS_NODE_ENV] === '1' && some((a) => /main\.cjs$/.test(a))) return true
  if (some((a) => a.includes('native-host.cjs'))) return true
  if (some((a) => a.startsWith(HOST_FLAG))) return true
  return false
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
  /* Phase 2：扩展读了页面送来的内容 —— 转给主进程（包装 / 落会话 / 审计都在那边做）。
     ⚠️ 这条是**兼容形态（run()）专用**的同步路径；路径 2 走 ext-host-loop.cjs。 */
  if (message && typeof message === 'object' && 'type' in message && message.type === P.KIND.EXT_PAGE) {
    const id = 'id' in message ? (message.id ?? null) : null
    return { ...forwardPage(message), id }
  }
  return { error: '只认 {"ping":…} 与 {type:"ext:page"}', echo: message ?? null }
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

/**
 * ★ 保命线：把 console.log 改道到 stderr。
 *
 * `core/log.cjs` 的 info 会 console.log —— 那是 stdout，就是协议通道。
 * 改道之后，**任何**模块（含白名单里那些）顺手打日志都不会污染帧。
 * 两个驱动（`run` / `runInteractive`）都必须先调它 —— 所以抽成一处，别各写一份。
 */
function redirectStdoutToStderr() {
  console.log = (...args) => console.error(...args)
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
  /* ★ 保命线（见 redirectStdoutToStderr 的说明）：先改道，再说话 */
  redirectStdoutToStderr()

  note(`已就绪（pid=${process.pid}，同步驱动）`)

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
        /* 与事件驱动那个出口同一规格：1 MiB 在 `encodeFrame` 里执行，超限换**降级帧**（不写违规帧） */
        const out = encodeFrameOrFallback(handleMessage(message), { max: MAX_FRAME })
        if (out.degraded) note(`回帧超限，已换成降级帧：${out.reason}`)
        fs.writeSync(1, out.frame)
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

/*
 * 直接跑这个文件（路径 2：`.cmd` → `Harbor.exe 本文件`）→ 进**事件驱动**的循环。
 * 它取代了老的同步 `run()`（那是兼容形态的遗留驱动，见 ext-host-loop.cjs 文件头）。
 */
const hostLoop = require('./core/ext-host-loop.cjs')

if (require.main === module) {
  hostLoop.runInteractive({ note, redirectOutput: redirectStdoutToStderr })
}

module.exports = {
  HOST_FLAG,
  RUN_AS_NODE_ENV,
  MAX_FRAME: P.MAX_FRAME,
  SAFE_MODULES,
  encodeFrame,
  encodeFrameOrFallback,
  decodeFrames,
  isHostArgv,
  handleMessage,
  redirectStdoutToStderr,
  note,
  run,
  runInteractive: hostLoop.runInteractive,
}
