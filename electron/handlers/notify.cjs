/**
 * 后台任务通知（AG-029）：系统级 + 推给渲染层
 *
 * 「应用内那条 toast 只在窗口看得见时有用」—— 缩到托盘、或者被别的窗口盖住时，
 * 用户根本不知道后台任务跑完了，所以这里补一条**系统通知**。
 *
 * ── 为什么判断放在主进程 ──
 * 「窗口现在是不是被用户看着」只有主进程答得准：最小化 / 藏到托盘 / 被别的
 * 窗口盖住，这三种都不是渲染层一个 `document.hasFocus()` 能分清楚的
 * （Electron 的 `win.isMinimized()` / `isVisible()` / `isFocused()` 才是原话）。
 * 系统通知本来就是主进程的活儿，判断和执行放在一处。
 *
 * 内容由 `core/task-notify.cjs` 生成**一次**，两条路共用：
 *   ① 窗口不在前台 → 系统通知（点它才聚焦窗口 —— 那是用户自己点的）
 *   ② 无论前后台 → 推 `app:taskEnd` 给渲染层（它决定要不要弹应用内提示）
 *
 * 依赖注入（Notification / app 从 main.cjs 传进来）而不是自己 require electron：
 * 自检要在没有 Electron 的环境里拿假对象跑这一组。
 */

const log = require('../core/log.cjs')
const taskNotify = require('../core/task-notify.cjs')
const taskCore = require('../core/task.cjs')

/** Windows 上不设这个，通知会挂在一个「electron.app.Electron」名下 */
const APP_ID = 'com.personalagent.workbench'

const MAX_TITLE = 120
const MAX_BODY = 400

function createTaskNotifier({ Notification, app, showWindow, getMainWindow }) {
  try {
    if (app && process.platform === 'win32') app.setAppUserModelId(APP_ID)
  } catch (error) {
    log.warn(`设置 AppUserModelId 失败：${error instanceof Error ? error.message : error}`)
  }

  /** 弹一条系统通知（点它：叫回窗口 + 告诉渲染层跳到那条任务） */
  function notify({ id = '', title, body = '' }) {
    const safeTitle = String(title ?? '').slice(0, MAX_TITLE)
    if (!safeTitle) return { ok: false, error: '缺标题' }
    try {
      if (!Notification || Notification.isSupported?.() === false) {
        log.warn('系统通知：这个平台不支持')
        return { ok: false, error: '平台不支持' }
      }
      const notification = new Notification({
        title: safeTitle,
        body: String(body).slice(0, MAX_BODY),
      })
      notification.on('click', () => {
        try {
          showWindow()
          getMainWindow()?.webContents?.send('app:notificationClick', { id: String(id) })
        } catch (error) {
          log.warn(`通知点击处理失败：${error instanceof Error ? error.message : error}`)
        }
      })
      notification.show()
      /* 通知只在「窗口不在前台」时才会发，出问题得能回查到底发没发 */
      log.info(`系统通知：${safeTitle}`)
      return { ok: true }
    } catch (error) {
      log.warn(`系统通知发不出去：${error instanceof Error ? error.message : error}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * 一轮跑完了（成功/失败/中断都走这里，见 chat.cjs 的 finally）。
   *
   * 任务状态不是「完成/失败」就什么都不做 —— 用户自己按的停止、
   * 或者预算用尽被标成 paused，都不该弹「任务完成」。
   */
  async function onRunEnd({ sessionId = '' } = {}) {
    try {
      /* task:list 按 updatedAt 倒序 —— 第一条就是这条对话最近的活儿 */
      const task = taskCore.list({ sessionId, limit: 1 })[0]
      const notice = taskNotify.endNotice(task?.status, task)
      if (!notice) return

      const win = getMainWindow()
      /*
       * 最小化单独判：Windows 上最小化之后 isVisible() 可能仍是 true、
       * isFocused() 是 false —— 而「最小化」正是最常用的那个场景，
       * 漏了它就会出现「明明最小化了却不弹通知」（用户实测提过）。
       */
      const background = !win || win.isMinimized() || !win.isVisible() || !win.isFocused()
      if (background) notify({ id: sessionId, title: notice.title, body: notice.description })
      /*
       * AG-033：把「改了几个文件」也带上 —— 渲染层据此决定给哪些「下一步」
       * （改了文件才有 diff / 测试 / 提交可言）。依据来自主进程的任务台账，
       * 渲染层不用再自己数一遍。
       */
      win?.webContents?.send('app:taskEnd', {
        sessionId,
        ...notice,
        files: (task?.changedFiles ?? []).length,
      })
    } catch (error) {
      log.warn(`任务通知失败：${error instanceof Error ? error.message : error}`)
    }
  }

  return { notify, onRunEnd }
}

module.exports = { createTaskNotifier, APP_ID }
