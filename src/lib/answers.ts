import type { Message } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   「回答属于哪一版提问」的纯函数

   背景（用户报的 bug）：提问本来就有多版本（编辑一次多一版），但回答没有
   「我答的是哪一版」的信息 → 切版本只能重新生成，生成品追加到文件末尾又没人
   认领，于是会话里并排堆着好几个回答 —— 而且**只有重新打开会话才看得见**
   （同一个会话里前端删了内存，看着是对的），用户因此把它描述成「切换会话之后」。

   这里只放纯函数，落在两个地方用：
     · 写侧（turns.ts）：这轮回答的是谁 → 落盘时标 answersKey / answersVersion
     · 界面（UserMessage / 回答的 ‹ n / N ›）：切版本、切回答**都不重跑**

   读侧的分组在 electron/core/session-answers.cjs（内核管存储形状）。
   ══════════════════════════════════════════════════════════════ */

/** 一条消息 → 落盘形状的回答记录（把界面字段收成存储字段） */
export function toAnswerRecord(message: Message): StoredMessage {
  return {
    role: 'assistant',
    key: message.id,
    content: message.content,
    ts: message.timestamp,
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.toolRuns?.length ? { toolRuns: message.toolRuns } : {}),
    ...(message.citations?.length ? { citations: message.citations } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.answersKey ? { answersKey: message.answersKey } : {}),
    ...(message.answersVersion !== undefined ? { answersVersion: message.answersVersion } : {}),
  }
}

/**
 * 这轮要回答的是哪条提问。
 *
 * 用「最后一条用户消息」而不是靠调用方传 —— 发送 / 编辑重跑 / 重新生成 /
 * 继续任务四条路都从这里过，各自传一遍迟早有人漏。
 */
export function questionTargetOf(messages: Message[]): { key: string; version: number } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user') return { key: m.id, version: m.versionIndex ?? 0 }
  }
  return null
}

/**
 * 这条回答的**全部版本** = 它记着的那些 + **它自己**。
 *
 * ★ 「自己」必须放进去。本轮刚生成的那条回答，`answerRecords` 里只装了
 *   被它取代的旧回答（seed），**它自己不在里面** —— 于是刚编辑完、再切回
 *   刚生成的那一版时，代码以为「这版没回答过」，又跑一整轮
 *   （用户报的「二度生成」就是这么来的：v1 → v0 → v1 来回切，每一步都重跑）。
 *
 * 按 key 去重：既能带上自己，又不会和内核分组的结果（那份本来就含自己）重复。
 */
export function allAnswers(message: Message): StoredMessage[] {
  const out = [...(message.answerRecords ?? [])]
  const self = toAnswerRecord(message)
  const at = out.findIndex((r) => r.key === self.key)
  if (at >= 0) out[at] = self
  else out.push(self)
  return out
}

/**
 * 这条提问后面已经有的回答（重新生成前先把旧的收着，别丢）。
 *
 * 从界面消息里凑出「落盘形状」的记录：优先用它自己带的 answerRecords
 * （重开会话时内核已经分组好了），没有就把这条本身当一条。
 */
export function existingAnswersAfter(
  messages: Message[],
  target: { key: string; version: number } | null,
): StoredMessage[] {
  if (!target) return []
  const at = messages.findIndex((m) => m.role === 'user' && m.id === target.key)
  if (at < 0) return []
  for (let i = at + 1; i < messages.length; i += 1) {
    const m = messages[i]
    if (m?.role === 'user') break
    if (m?.role !== 'assistant' || !m.content) continue
    /* ★ 用 allAnswers：连它自己也带上 —— 不然连着编辑两次就会把中间那条丢掉 */
    return allAnswers(m)
  }
  return []
}

/** 某条回答里，属于指定提问版本的那些（界面切提问版本时用） */
export function answersOfVersion(
  records: StoredMessage[] | undefined,
  version: number,
): StoredMessage[] {
  return (records ?? []).filter((r) => (r.answersVersion ?? 0) === version)
}

/** 把一条回答记录摊成消息字段（切换时更新同一条消息，不新增、不重跑） */
export function answerPatch(record: StoredMessage, index: number): Partial<Message> {
  return {
    content: record.content,
    reasoning: record.reasoning ?? '',
    toolRuns: record.toolRuns ?? [],
    citations: record.citations ?? [],
    ...(record.usage ? { usage: record.usage } : {}),
    answerIndex: index,
    status: 'sent',
    kind: 'text',
  }
}
