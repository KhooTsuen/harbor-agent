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
const redact = require('../core/redact.cjs')
const taskNotify = require('../core/task-notify.cjs')
const taskCore = require('../core/task.cjs')
const taskOutcome = require('../core/task-outcome.cjs')

/** Windows 上不设这个，通知会挂在一个「electron.app.Electron」名下 */
const APP_ID = 'dev.harbor.agent'

const MAX_TITLE = 120
const MAX_BODY = 400

/**
 * 窗口现在是不是「不在前台」：没有窗口 / 最小化 / 不可见 / 没焦点。
 *
 * 抽出来是因为 **两种通知都要这个判据**（任务结束、需要你确认），
 * 各写一遍就会漂。最小化必须显式判：Windows 上最小化之后 `isVisible()`
 * 可能仍是 true、`isFocused()` 是 false。
 */
function isBackground(win) {
  return !win || win.isMinimized() || !win.isVisible() || !win.isFocused()
}

function createTaskNotifier({ Notification, app, showWindow, getMainWindow }) {
  try {
    if (app && process.platform === 'win32') app.setAppUserModelId(APP_ID)
  } catch (error) {
    log.warn(`设置 AppUserModelId 失败：${error instanceof Error ? error.message : error}`)
  }

  /**
   * 弹一条系统通知（点它：叫回窗口 + 告诉渲染层跳到那条任务）
   *
   * @param {{ id?: string, title?: string, body?: string, kind?: string }} input
   *   `kind` 会跟着点击事件回渲染层 —— 空的 = 任务结束（默认，跳任务中心）；
   *   `confirm` = 「需要你确认」（跳那条对话 + 聚焦卡片）；
   *   `browse` = 「Agent 在动网页」（跳那条对话 + 右栏落到浏览器标签）
   */
  function notify({ id = '', title, body = '', kind = '' }) {
    /*
     * ★ 系统通知是**唯一会离开本应用**的出口：它留进 Windows 通知历史、
     *   屏幕共享 / 录屏 / 投屏时别人直接看得到。而两处内容源都是未脱敏的原文
     *   （run_shell 的命令原文、任务结论的首行），所以这里必须过一道（审计问题 24）。
     */
    const safeTitle = redact.redact(String(title ?? '')).slice(0, MAX_TITLE)
    if (!safeTitle) return { ok: false, error: '缺标题' }
    try {
      if (!Notification || Notification.isSupported?.() === false) {
        log.warn('系统通知：这个平台不支持')
        return { ok: false, error: '平台不支持' }
      }
      const notification = new Notification({
        title: safeTitle,
        body: redact.redact(String(body ?? '')).slice(0, MAX_BODY),
      })
      notification.on('click', () => {
        try {
          showWindow()
          getMainWindow()?.webContents?.send('app:notificationClick', {
            id: String(id),
            kind: String(kind),
          })
        } catch (error) {
          log.warn(`通知点击处理失败：${error instanceof Error ? error.message : error}`)
        }
      })
      notification.show()
      /*
       * 通知只在「窗口不在前台」时才会发，出问题得能回查到底发没发、发的什么 ——
       * 真机上（尤其 Windows）通知弹没弹、弹了什么，只有这一行能作证。
       */
      log.info(`系统通知：${safeTitle}｜${String(body).replace(/\s+/g, ' ').slice(0, 60)}`)
      return { ok: true }
    } catch (error) {
      log.warn(`系统通知发不出去：${error instanceof Error ? error.message : error}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /* 已经为哪几张卡发过通知 —— 「只发一次，不重复」（用户 2026-10-03 的要求） */
  const toldConfirm = new Set()

  /* 浏览通知的去重集：按**会话**去重（一条对话只提醒一次，见 notifyBrowse） */
  const toldBrowse = new Set()

  /**
   * 「需要你确认」（2026-10-03 用户报的）：澄清卡 / 权限确认弹出来时，
   * 如果窗口不在前台就发一条系统通知 —— 不然用户切走了根本不知道任务在等他，
   * 任务就一直挂在那个卡上。
   *
   * 三条约束（都是用户明确提的）：
   *   · **不在前台才发** —— 用上面那个 isBackground（和任务结束通知同一套判据）；
   *   · **只发一次** —— 同一张卡（key）重复调只发第一条；
   *   · **不抢焦点** —— 这里只发通知；窗口是**用户点通知**之后才叫回来的
   *     （走 notify 的 click 回调），和 AG-029 一个规矩。
   *
   * @param {{ id?: string, key?: string, title?: string, body?: string }} input
   *   `id` = 回渲染层用来跳转的会话 id；`key` = 去重用的卡片 id（默认同 id）
   */
  function notifyConfirm({ id = '', key = '', title, body = '' }) {
    const dedupe = String(key || id || '')
    if (dedupe && toldConfirm.has(dedupe)) {
      log.info(`需要确认：这张卡已经发过通知了（${dedupe}）`)
      return { ok: false, error: '已经发过了' }
    }
    if (!isBackground(getMainWindow())) {
      /* 前台不发是**正常路径**（用户正看着），但也要能回查「为什么没有通知」 */
      log.info('需要确认：窗口在前台，不发系统通知')
      return { ok: false, error: '窗口在前台' }
    }
    /* 不发散记账：超过 50 张就清一次（每张卡都是秒级结算的东西） */
    if (toldConfirm.size > 50) toldConfirm.clear()
    if (dedupe) toldConfirm.add(dedupe)
    return notify({ id, title, body, kind: 'confirm' })
  }

  /**
   * 「Agent 在动网页，而你没在看」（2026-10-04，收尾第一步）。
   *
   * 和 `notifyConfirm` 同一套口径（不在前台才发 / 同一个 key 只发一次 / 不抢焦点），
   * 只有去重粒度不一样：澄清卡是「一张卡一条」，这里是「**一条对话一条**」——
   * 一个任务里 browse 十几次是常态，每次都弹会被人直接关掉通知。
   *
   * @param {{ id?: string, key?: string, title?: string, body?: string }} input
   *   `id` = 会话 id（点通知后切回那条对话）；`key` = 去重键（默认同 id）
   */
  function notifyBrowse({ id = '', key = '', title, body = '' }) {
    const dedupe = String(key || id || 'browse')
    if (toldBrowse.has(dedupe)) {
      log.info(`浏览通知：这条对话已经发过了（${dedupe}）`)
      return { ok: false, error: '已经发过了' }
    }
    if (!isBackground(getMainWindow())) {
      /* 前台不发是**正常路径**（用户正看着，界面已有 toast 与面板切换） */
      log.info('浏览通知：窗口在前台，不发系统通知')
      return { ok: false, error: '窗口在前台' }
    }
    if (toldBrowse.size > 50) toldBrowse.clear()
    toldBrowse.add(dedupe)
    return notify({ id, title, body, kind: 'browse' })
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
       * 「窗口不在前台」的判据抽在 isBackground 里（和「需要你确认」共用）——
       * 最小化必须显式判：Windows 上最小化之后 isVisible() 可能仍是 true、
       * isFocused() 是 false —— 而「最小化」正是最常用的那个场景，
       * 漏了它就会出现「明明最小化了却不弹通知」（用户实测提过）。
       */
      if (isBackground(win)) notify({ id: sessionId, title: notice.title, body: notice.description })
      /*
       * AG-033/034：把「这一轮到底干了什么」带上 —— 渲染层据此决定给哪些
       * 「下一步」（改了文件才有 diff / 测试 / 提交；测试跑过就不必再劝它跑）。
       * 判读都在任务台账上做（core/task-outcome.cjs），渲染层不自己猜。
       */
      win?.webContents?.send('app:taskEnd', {
        sessionId,
        ...notice,
        outcome: taskOutcome.outcomeOf(task),
      })
    } catch (error) {
      log.warn(`任务通知失败：${error instanceof Error ? error.message : error}`)
    }
  }

  return { notify, notifyBrowse, notifyConfirm, onRunEnd }
}

module.exports = { createTaskNotifier, isBackground, APP_ID }
