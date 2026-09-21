/**
 * 真终端（PTY）
 *
 * 和 handlers/shell.cjs 的区别：
 *   shell.cjs  —— 一次性执行一条命令，收输出。够用，但**没有 stdin**，
 *                 交互式程序（vim / python REPL / 需要回车确认的提示）会卡死。
 *   pty.cjs    —— 挂一个真的伪终端，程序以为自己连的是终端，
 *                 能收键盘、能全屏、能上色。
 *
 * 几个必须知道的事：
 *
 * ① 输出是 **ANSI/VT 转义序列**（光标移动、清屏、改色、切备用屏），
 *    渲染层必须用真终端模拟器（@xterm/xterm）接，当纯文本画就是满屏乱码。
 *
 * ② 一个 PTY = 一个子进程。**退出时必须杀干净**，否则 cmd.exe 会越攒越多。
 *    所以有 killAll()，主进程退出时调。
 *
 * ③ Windows 的 ConPTY 需要 conpty.dll / OpenConsole.exe 这两个二进制，
 *    node-pty 的 prebuilds/win32-x64 里带着 —— 打包时不能漏（见 build-portable.mjs）。
 *
 * ④ 用的是 N-API 预编译包，Node 和 Electron 的 ABI 都能直接加载，
 *    **不需要 electron-rebuild**（scripts/pty-check.cjs 可以验证这一点）。
 */

const pty = require('node-pty')
const config = require('./config.cjs')
const log = require('./log.cjs')

/** id -> { proc, cols, rows, startedAt } */
const sessions = new Map()

/** 终端尺寸下限 —— 传 0 进去 conpty 会直接抛异常 */
const MIN_COLS = 2
const MIN_ROWS = 1

function defaultShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

function baseDir() {
  const { DIRS } = require('./paths.cjs')
  return config.get().general.workdir || DIRS.workspace
}

function clamp(value, min, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.floor(num))
}

/**
 * 开一个终端会话。
 *
 * @param {object} options
 * @param {string} options.id       前端给的会话 id
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @param {string} [options.cwd]
 * @param {(chunk: string) => void} [options.onData]
 * @param {(info: {exitCode: number, signal?: number}) => void} [options.onExit]
 */
function start({ id, cols, rows, cwd, onData, onExit }) {
  if (!id) return { ok: false, error: '缺会话 id' }

  /* 同一个 id 重复开：把旧的收掉，免得留下孤儿进程 */
  if (sessions.has(id)) kill(id)

  const size = { cols: clamp(cols, MIN_COLS, 80), rows: clamp(rows, MIN_ROWS, 24) }
  const shell = defaultShell()
  const dir = cwd || baseDir()
  /*
   * ★ 中文 Windows 上要先给 cmd 切代码页：内核控制台默认 GBK，而终端（xterm.js）
   *   按 UTF-8 渲染 —— 不切的话 `dir` / `echo 中文` 在终端里全是乱码。
   *   `>nul` 免得把「Active code page: 65001」打在第一屏。
   */
  const args = process.platform === 'win32' ? ['/k', 'chcp 65001 >nul'] : []

  let proc
  try {
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: dir,
      /*
       * 用包里自带的 conpty.dll，不用 Windows 内置的那个。
       *
       * 不只是版本一致的问题：用内置 conpty 时，node-pty 的 kill() 会
       * **fork 一个 helper 进程**去枚举控制台进程列表，而那个 helper 在
       * 「父进程本来就带着控制台」的情况下（比如从终端里跑 npm start）
       * 会报 AttachConsole failed 然后带着一整条堆栈崩掉 —— 不影响主进程，
       * 但看着像出事了，而且实测那条路径下子进程不会被逐个杀掉。
       * 走到 DLL 分支就干净了：直接关句柄收会话。
       */
      useConptyDll: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        /* 让子进程里的工具知道往哪儿写；也给「这是不是真终端」一个标记 */
        PERSONAL_AGENT_PTY: '1',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`开终端失败：${message}`)
    return { ok: false, error: `开终端失败：${message}` }
  }

  const session = { id, proc, cols: size.cols, rows: size.rows, startedAt: Date.now() }
  sessions.set(id, session)

  proc.onData((chunk) => {
    /* 会话可能在回调之间被关掉（前端切走了），这里要再确认一次 */
    if (sessions.has(id)) onData?.(chunk)
  })

  proc.onExit(({ exitCode, signal }) => {
    sessions.delete(id)
    log.info(`终端退出：${id} code=${exitCode}`)
    onExit?.({ exitCode, signal })
  })

  log.info(`终端启动：${id} · ${shell} · ${size.cols}×${size.rows} · ${dir}`)
  return { ok: true, id, shell, pid: proc.pid, cols: size.cols, rows: size.rows }
}

/** 把键盘输入喂给程序 */
function write(id, data) {
  const session = sessions.get(String(id))
  if (!session) return { ok: false, error: '会话不在了' }
  try {
    session.proc.write(String(data ?? ''))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 面板尺寸变了要告诉程序 —— 不然 vim/top 的画面对不齐 */
function resize(id, cols, rows) {
  const session = sessions.get(String(id))
  if (!session) return { ok: false, error: '会话不在了' }

  const next = {
    cols: clamp(cols, MIN_COLS, session.cols),
    rows: clamp(rows, MIN_ROWS, session.rows),
  }
  if (next.cols === session.cols && next.rows === session.rows) return { ok: true }

  try {
    session.proc.resize(next.cols, next.rows)
    session.cols = next.cols
    session.rows = next.rows
    return { ok: true }
  } catch (error) {
    /* 刚退出时 resize 会抛，正常现象，不当错误上报 */
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function kill(id) {
  const session = sessions.get(String(id))
  if (!session) return { ok: true }
  sessions.delete(String(id))
  try {
    session.proc.kill()
  } catch {
    /* 已经退了 */
  }
  return { ok: true }
}

/** 主进程退出前必须调 —— 不然每关一次窗口就漏一批子进程 */
function killAll() {
  const count = sessions.size
  for (const [, session] of sessions) {
    try {
      session.proc.kill()
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear()
  if (count > 0) log.info(`关了 ${count} 个终端会话`)
  return { ok: true, closed: count }
}

function list() {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    pid: session.proc.pid,
    cols: session.cols,
    rows: session.rows,
    startedAt: session.startedAt,
  }))
}

module.exports = { start, write, resize, kill, killAll, list, defaultShell }
