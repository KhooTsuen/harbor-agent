/**
 * host → Harbor 主进程的转发（Phase 2）
 *
 * 单独一个文件的原因：`native-host.cjs` 已经 293 行（贴 300 红线），再加转发逻辑
 * 就超；而这块逻辑本身是自洽的（「算数据根 → 算管道名 → 同步写进去 → 判错误」），
 * 拆出来还能被自检直接跑。
 *
 * ── 为什么是**同步写**，以及为什么不等回复 ────────────────────
 *
 * host 的主循环是 `for(;;)` + `fs.readSync(0,…)` 的**同步阻塞**结构（见 native-host.cjs），
 * 不能 await 异步的 `net.connect`。实测（2026-10-15 探针）：
 *   · `fs.writeFileSync('\\\\.\\pipe\\名', buf)` **同步写成功**（含 64 KB）；
 *   · 管道**没有监听时立刻抛 ENOENT**（不阻塞）—— 正好用来判「Harbor 没在运行」。
 *
 * 不回读回复：`writeFileSync` 是「打开→写→关」，关掉写端后读回复要么另开一次
 * 连接（语义变成两条消息）、要么在同一个 fd 上同步 read（主进程不回复就永久阻塞、
 * host 当场卡死）。Phase 2 不需要回执 —— 扩展只要知道「发出去了没有」，
 * 处理结果通过 Harbor 界面体现（主进程会 send `ext:page` 给渲染层）。
 */

const fs = require('node:fs')
const path = require('node:path')
const bridge = require('./ext-bridge.cjs')

/** 数据根的环境变量名（由 harbor-host.cmd 用 %~dp0 传入） */
const DATA_ENV = 'HARBOR_DATA_ROOT'

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

/**
 * 把扩展送来的页面内容转给 Harbor 主进程。
 *
 * ★ **单向的**，如实说清（探针实测）：
 *   host 用 `fs.writeFileSync(pipe, …)`（打开→写→关），主进程收到「连接结束」才处理，
 *   那时连接已关 —— **host 读不到主进程的回复**。所以下面的 `delivered: true`
 *   只表示「字节成功写进了管道」，**不表示主进程已经落进会话**。
 *   扩展侧的结果文案按这个口径写（见 extension/service-worker.js）。
 *
 * @param {Record<string, unknown> | null | undefined} message
 * @returns {{ type: string, ok: boolean, chars: number, delivered: boolean, error?: string }}
 *   回给扩展的形状（扩展据此显示「已读取 X 字」或人话错误）
 */
function forwardPage(message) {
  const url = String(message?.url ?? '')
  const title = String(message?.title ?? '')
  const text = String(message?.text ?? '')
  const truncated = message?.truncated === true

  const dataDir = hostDataDir()
  if (!dataDir) {
    return { type: 'ext:page.result', ok: false, chars: text.length, delivered: false, error: '定位不到 Harbor 的数据目录' }
  }

  const payload = { token: bridge.readToken(dataDir), kind: 'ext:page', url, title, text, truncated, ts: Date.now() }
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  if (bytes.length > bridge.MAX_MESSAGE) {
    return { type: 'ext:page.result', ok: false, chars: text.length, delivered: false, error: '页面太大，超出单条消息上限' }
  }

  try {
    fs.writeFileSync(bridge.pipeName(dataDir), bytes)
    return { type: 'ext:page.result', ok: true, chars: text.length, delivered: true }
  } catch (error) {
    const code = error && error.code
    const hint =
      code === 'ENOENT'
        ? 'Harbor 没有在运行（或扩展通道没安装）'
        : `${code || ''} ${error instanceof Error ? error.message : error}`.trim()
    return { type: 'ext:page.result', ok: false, chars: text.length, delivered: false, error: hint }
  }
}

module.exports = { DATA_ENV, hostDataDir, forwardPage }
