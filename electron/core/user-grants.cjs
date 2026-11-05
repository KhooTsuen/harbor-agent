/**
 * 「授权」的进程内记忆 —— 让「已经批过」跨轮次继续算数
 *
 * 病（2026-11-06 真机现场）：授权的作用域是**一条用户消息**，用户的心智是**这件事**。
 *   用户上一条写「本轮明确授权修改相关源码、测试、规范」，下一条只说「我已重启好了」——
 *   `lastUserText` 换了内容，`grantsWriteIn` 回到 false，于是第一次覆盖老文件
 *   又被问了一遍。用户看到的就是：同一件事问了两遍。
 *
 * ★ 判据**不在这里**。唯一真相源是 `user-constraints.cjs` 的 `grantsWriteIn` /
 *   `noWriteIn`：调用方把算好的两个布尔传进来，这里只存「这个会话里他说过授权」
 *   这一个事实。两边各写一套正则 = 硬约束 9 的那类事故，别再犯。
 *
 * ★ 状态属于**会话**（不是任务）。任务一结束就丢，正是重复打扰的来源；
 *   会话边界才是用户心里的「这件事」。进程内 Set，不落盘、不改数据结构、
 *   重启清空 —— 重启之后是新的一次对话，本来就该重新问。
 *
 * 撤销只有一种：他明确说了停手 / 这一轮只读。没有过期时间 —— 会话里说过的授权，
 * 在他自己开口收回之前一直算数；收回的方式（「先别动」「这轮只分析」）已有判据。
 */

/** 最多记多少个会话 —— 防止长跑进程里无限增长（超出就丢最早的） */
const SESSION_CAP = 64

const grantedSessions = new Set()

/**
 * 记一次「这一轮用户说了什么」。
 *
 * @param {string} sessionId
 * @param {{ granted?: boolean, stopped?: boolean }} [signals]
 *   `granted` = `grantsWriteIn(userText)`；`stopped` = `noWriteIn(userText)`。
 *   由调用方用 `user-constraints.cjs` 算好传进来（那里是唯一真相源）。
 */
function noteGrant(sessionId, signals = {}) {
  const id = String(sessionId ?? '')
  if (!id) return
  const { granted = false, stopped = false } = signals
  /* 停手优先：同一句话里又授权又说只读，按最保守的理解处理 */
  if (stopped) {
    grantedSessions.delete(id)
    return
  }
  if (!granted) return
  grantedSessions.add(id)
  if (grantedSessions.size > SESSION_CAP) {
    grantedSessions.delete(grantedSessions.values().next().value)
  }
}

/**
 * 这个会话里他授权过动手吗。
 *
 * @param {string} [sessionId]
 * @returns {boolean}
 */
function sessionGranted(sessionId) {
  return grantedSessions.has(String(sessionId ?? ''))
}

/** 自检用：清空记忆（不进生产路径） */
function resetSessionGrants() {
  grantedSessions.clear()
}

module.exports = { noteGrant, sessionGranted, resetSessionGrants, SESSION_CAP }
