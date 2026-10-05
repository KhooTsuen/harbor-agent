/**
 * 「Agent 在你看不见的地方动网页」→ 发一条系统通知（2026-10-04，收尾第一步）
 *
 * 为什么需要它：窗口不在前台时，Agent 打开网页 / 点按钮 / 打字这一串在界面上
 * 只表现为「右侧面板切到了浏览器标签」—— 用户没在看屏幕就完全不知道。
 * 和「需要你确认」（P1-3）是同一类问题，所以照那套写：注入点 + 调用口径，
 * 真判断（在不在前台、发过没有）留在 `handlers/notify.cjs`。
 *
 * 三条口径：
 *   · **不在前台才发** —— 前台有 toast 和面板切换，再弹通知就是打扰；
 *   · **一次任务最多一条** —— 一个任务里 browse 十几次是常态，每次都弹会被人关掉通知；
 *   · **不抢焦点** —— 只发通知；窗口是用户**点了通知**之后才叫回来的（kind: 'browse'）。
 *
 * 没接通知器（自检 / 没有 Electron）时安静地什么都不做。
 */

let notifier = null

/** 装配线（`register-handlers.cjs`）把通知器接进来；自检不接。 */
function setNotifier(value) {
  notifier = value ?? null
}

/** 四种动作各说一句人话（纯函数，单测直接断言） */
const ACTION_TEXT = {
  navigate: { title: 'Agent 正在打开网页', body: '右侧面板已切到「浏览器」，可以看它在读哪个页面' },
  snapshot: { title: 'Agent 正在读网页上的元素', body: '它在找可点/可填的东西' },
  click: { title: 'Agent 正在网页上点击', body: '它在替你操作页面' },
  type: { title: 'Agent 正在网页上输入', body: '它在替你填内容' },
  nav: { title: 'Agent 正在网页里后退/前进', body: '用的浏览器历史，不会新开标签' },
}

/**
 * 通知文案。
 *
 * @param {string} action 'navigate' | 'snapshot' | 'click' | 'type'
 * @param {string} [url]  navigate 时带上地址（用户一眼知道在读哪儿）
 */
function browseNotice(action, url = '') {
  const base = ACTION_TEXT[String(action)] ?? { title: 'Agent 正在用浏览器', body: '' }
  const tail = url ? `\n${String(url).slice(0, 120)}` : ''
  return { title: base.title, body: `${base.body}${tail}`.slice(0, 200) }
}

/**
 * 告诉用户一声（能不能发、发过没有由通知器判断）。
 *
 * @param {{ sessionId?: string, action?: string, url?: string }} input
 *   `sessionId` 既用来**去重**（一条对话一条）也回渲染层（点通知后切到浏览器标签）
 */
function tellUser({ sessionId = '', action = '', url = '' } = {}) {
  if (!notifier?.notifyBrowse) return
  notifier.notifyBrowse({
    id: String(sessionId),
    key: String(sessionId || 'browse'),
    ...browseNotice(action, url),
  })
}

module.exports = { setNotifier, tellUser, browseNotice, ACTION_TEXT }
