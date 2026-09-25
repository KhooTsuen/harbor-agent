/* ══════════════════════════════════════════════════════════════
   重新生成的排队与「连着点了几次」

   两个小状态放在这里（**不 import 任何模块** —— useThreadStore ↔ turns
   已经互相看得见，再引 store 就成环了）：

   ① **流式中的重新生成**要等旧生成真正收尾再开跑：
      点的时候先中止（abortChat），把请求排在这；turns.finish()（一轮结束的
      统一出口，done / 超时 / 中止都走它）调 drainPendingRegen 放它出去。
      不排队直接跑的话会和还在收尾的那一轮抢上下文（旧回答续写、文件还开着）。

   ② **连续重新生成计数**：同一提问连着重来超过 5 次 → 提示换个方向。
      键是提问在内存里的 id，重开会话清零 —— 「连续」语义够用，不落盘。
   ══════════════════════════════════════════════════════════════ */

/** 连着重新生成到第几次开始劝（超过它才提示：第 6 次） */
export const REGEN_STREAK_LIMIT = 5

/** 由 store 初始化时注入（注册的是 regenerateMessage 本身） */
let runner: ((messageId: string) => void) | null = null
const pending = new Map<string, string>() // threadId → 待重新生成的消息 id
const streak = new Map<string, number>() // 提问消息 id → 连续重新生成次数

export function setRegenRunner(fn: (messageId: string) => void): void {
  runner = fn
}

/** 排一个「等这轮结束再重新生成」的请求（同一对话只留最后一个） */
export function queueRegen(threadId: string, messageId: string): void {
  pending.set(threadId, messageId)
}

export function hasPendingRegen(threadId: string): boolean {
  return pending.has(threadId)
}

/** turns.finish() 调：有排着的就放它开跑（先清「在跑」、再调用，顺序在 finish 里） */
export function drainPendingRegen(threadId: string): void {
  const messageId = pending.get(threadId)
  if (!messageId || !runner) return
  pending.delete(threadId)
  runner(messageId)
}

/** 记一次「又重来了」；返回这已是第几次 */
export function bumpRegenStreak(questionId: string): number {
  const next = (streak.get(questionId) ?? 0) + 1
  streak.set(questionId, next)
  return next
}
