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
    return m.answerRecords?.length ? m.answerRecords : [toAnswerRecord(m)]
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
