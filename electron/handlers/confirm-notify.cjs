/**
 * 「需要你确认」的系统通知（P1-3）—— 注入点 + 发送
 *
 * 为什么要单独一个文件：`chat-confirm.cjs` 已经贴着 300 行红线（硬约束 #2），
 * 而这块是「**怎么**把通知发出去」，和「卡片什么时候挂、怎么结算」是两件事。
 *
 * 三层分工，各管一件事（别把它们混起来）：
 *   · `core/confirm-notice.cjs`   —— 文案（纯函数，自检直接断言）
 *   · 这里                        —— 通知器的注入点 + 调用口径
 *   · `handlers/notify.cjs`       —— 「不在前台才发 / 只发一次」的真判断与真发送
 *   · `handlers/chat-confirm.cjs` —— **什么时候**调（卡片推给渲染层的那一刻）
 *
 * 没接通知器（自检 / 没有 Electron）时安静地什么都不做 ——
 * 用户不在前台时他该看到的是一条系统通知，不是别的替代品。
 */

const { confirmNotice, clarifyAsk, permissionAsk } = require('../core/confirm-notice.cjs')

let notifier = null

/** 装配线（`register-handlers.cjs`）把通知器接进来；自检不接。 */
function setNotifier(value) {
  notifier = value ?? null
}

/**
 * 「一边等你点头，一边你人不在」→ 发一条系统通知（不在前台才发、同一张卡只发一次）。
 *
 * @param {{ sessionId?: string, key?: string, ask?: string }} input
 *   `sessionId` 要回渲染层（点通知后切到那条对话）；`key` 是卡片 id，用来去重
 */
function tellUser({ sessionId = '', key = '', ask = '' } = {}) {
  if (!notifier?.notifyConfirm) return
  notifier.notifyConfirm({
    id: String(sessionId),
    key: String(key),
    ...confirmNotice(ask),
  })
}

module.exports = { setNotifier, tellUser, clarifyAsk, permissionAsk }
