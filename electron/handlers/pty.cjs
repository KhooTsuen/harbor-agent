/**
 * 终端（PTY）IPC
 *
 * 和三栏那个「终端」标签一一对应。为什么不用 invoke 的返回值传输出：
 * 终端输出是**持续不断**的（几毫秒一个 chunk），invoke 只能一问一答，
 * 所以走主进程主动 send（`pty:data`）。
 */

const pty = require('../core/pty.cjs')

function register({ ipcMain, send, getWorkdir }) {
  /** 开一个终端 */
  ipcMain.handle('pty:start', (_event, payload = {}) => {
    const id = String(payload.id ?? '')
    return pty.start({
      id,
      cols: payload.cols,
      rows: payload.rows,
      cwd: payload.cwd || getWorkdir?.(),
      onData: (chunk) => send('pty:data', { id, chunk }),
      onExit: (info) => send('pty:exit', { id, exitCode: info.exitCode }),
    })
  })

  /** 键盘输入 */
  ipcMain.handle('pty:write', (_event, payload = {}) => pty.write(payload.id, payload.data))

  /** 面板尺寸变化 */
  ipcMain.handle('pty:resize', (_event, payload = {}) =>
    pty.resize(payload.id, payload.cols, payload.rows),
  )

  /** 关掉一个会话 */
  ipcMain.handle('pty:stop', (_event, payload = {}) => pty.kill(payload.id))

  /** 全关（窗口关闭 / 退出时用） */
  ipcMain.handle('pty:stopAll', () => pty.killAll())

  /** 当前活着的会话（排查「为什么后台挂着一堆 cmd.exe」用） */
  ipcMain.handle('pty:list', () => ({ ok: true, sessions: pty.list() }))
}

module.exports = { register }
