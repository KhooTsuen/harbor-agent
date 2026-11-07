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
    /*
     * 卡片授权只在「**比它更新**的这句话说停手」时才撤销。
     *
     * ★ 为什么必须比时刻（2026-11-07 自检逮到的真错）：`noteGrant` 每轮开头都调，
     *   传的是**最后一条**用户消息。用户说「只分析」→ 被拦 → 弹卡片 → 用户点「允许写」，
     *   这时最新消息**仍然是**「只分析」；下一次建 ctx 若照旧清掉，等于
     *   「他刚点的同意被他自己更早那句话推翻了」—— 正是这个缺陷的翻版。
     *   同一轮里 noteGrant 发生在授权**之前**（`now < at`）→ 不清；
     *   授权之后用户发新消息说停手（`now > at`）→ 清。语义就是「更新的拒绝才算数」。
     */
    const now = Date.now()
    for (const [key, hit] of [...cardGrants]) {
      if (key.startsWith(`${id}::`) && now > (hit?.at ?? 0)) cardGrants.delete(key)
    }
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
  cardGrants.clear()
}

/*
 * ── 卡片授权（2026-11-07）──────────────────────────────────────
 *
 * 病：用户在 `ask_user` 卡片上点了「放开约束」，后续写操作**照样被拦**。
 *   `user-constraints` 判的是消息正文，而卡片答复走 `chat-confirm` → 工具返回值
 *   那条通道，从来没有回写运行时约束。用户看到的是「我点了同意，它还说不行」。
 *
 * ★ 判据不从自然语言来：模型在**选项上**声明 `intent`（`clarify.cjs` 的白名单），
 *   用户在卡片上点中它 = 一条结构化授权事件。这样不新增第二套语义，
 *   也不会把「用户答了个普通问题」误当成授权。
 *
 * ★ 作用域 = **这个会话的这个任务**（不是全局、不跨任务）：需求要求「仅对获批的
 *   任务和操作生效」。任务一换，key 就变了，天然不继承。
 * ★ 撤销有三种，都走同一条：`deny-write` 选项 / 正文说停手（`noteGrant` 的
 *   `stopped`）/ 会话结束。**更新的拒绝一定盖过更早的授权** —— 靠 at 比对。
 */
const cardGrants = new Map()

const keyOf = (sessionId, taskId) => `${String(sessionId ?? '')}::${String(taskId ?? '')}`

/**
 * 用户在卡片上点了一个带意图的选项。
 *
 * @param {{ sessionId?: string, taskId?: string, intents?: string[] }} input
 * @returns {{ granted: boolean, revoked: boolean }}
 */
function noteCardGrant({ sessionId, taskId, intents } = {}) {
  const id = String(sessionId ?? '')
  const list = Array.isArray(intents) ? intents : []
  if (!id || list.length === 0) return { granted: false, revoked: false }
  const key = keyOf(id, taskId)
  /* 拒绝优先：同一张卡里又同意又拒绝（多个问题），按最保守的算 */
  if (list.includes('deny-write')) {
    cardGrants.delete(key)
    return { granted: false, revoked: true }
  }
  if (!list.includes('grant-write')) return { granted: false, revoked: false }
  cardGrants.set(key, { at: Date.now() })
  return { granted: true, revoked: false }
}

/**
 * 这个任务的卡片授权还有效吗。
 *
 * @param {string} [sessionId]
 * @param {string} [taskId]
 */
function cardGranted(sessionId, taskId) {
  const id = String(sessionId ?? '')
  if (!id) return false
  const hit = cardGrants.get(keyOf(id, taskId))
  return Boolean(hit)
}

module.exports = {
  noteGrant,
  sessionGranted,
  noteCardGrant,
  cardGranted,
  resetSessionGrants,
  SESSION_CAP,
}
