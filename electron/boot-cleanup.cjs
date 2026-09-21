/**
 * 启动清扫 / 退出清理
 *
 * 从 main.cjs 抽出来的（那边贴到 300 行上限了）。这里的四件事有个共同点：
 * **都是「进程要没了 / 刚起来」时的兜底**，做错了不会当场报错，只会在下一次
 * 启动时以某种奇怪的样子露出来 —— 所以集中在一处、每件都有注释说明为什么。
 *
 * 每件都单独 try：清理里任何一件失败都不该拦住后面几件（用户按退出时，
 * 最差也要把终端子进程杀掉，不然会一直漏 cmd.exe 出来）。
 */

const log = require('./core/log.cjs')

function warn(what, error) {
  log.warn(`${what}：${error instanceof Error ? error.message : error}`)
}

/**
 * 启动时扫一遍上一轮遗留的「还在跑」任务。
 *
 * 用户报过：「任务跑着的时候进程被中断，再打开时那个进行中的对话没保留」。
 * 实测复现后磁盘上剩的是 `status: running` —— 而能「接着做」的状态只有
 * `paused` / `waiting_user`，于是任务看得见、**点不了继续**。
 *
 * 为什么启动时扫就够了：`will-quit` 只在**优雅退出**时跑，进程被强杀/崩溃时
 * 根本不会执行。应用是单实例，启动时不可能真的有循环在跑。
 *
 * ★ 必须在建窗口之前调用 —— 否则第一次渲染出来的还是「在跑」的旧状态。
 */
function sweepStaleTasks() {
  try {
    require('./core/task.cjs').pauseRunning('startup')
  } catch (error) {
    warn('清扫遗留任务失败', error)
  }
}

/** 用户退出时的清理。`destroyTray` 由 main 传进来（托盘实例在那边） */
function onQuit({ destroyTray } = {}) {
  /*
   * 终端子进程必须杀干净：conpty 的子进程不会跟着父进程退出，
   * 漏一批就是一堆挂在 ConPTY 会话上的 cmd.exe。
   */
  try {
    require('./core/pty.cjs').killAll()
  } catch (error) {
    warn('清理终端会话失败', error)
  }

  /* 没干完的任务标成「暂停」—— 下次启动才认得出该提示用户续做 */
  try {
    require('./core/task.cjs').pauseRunning()
  } catch (error) {
    warn('标记任务状态失败', error)
  }

  /*
   * 托盘图标要**显式销毁** —— 用户报过「退出后图标还挂在右下角」。
   * Electron 通常会自己清理，但退出路径稍有不同（app.exit / 进程被杀 /
   * Windows 没收到托盘重生通知）就会漏。别把这事托付给"应该会"。
   */
  try {
    destroyTray?.()
  } catch (error) {
    warn('销毁托盘失败', error)
  }
}

module.exports = { sweepStaleTasks, onQuit }
