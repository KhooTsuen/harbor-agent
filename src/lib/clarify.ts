import type { ClarifyQuestion, ClarifyReply } from '@/types'

/* ══════════════════════════════════════════════════════════════
   开工前澄清（AG-053）—— 渲染层的措辞与「上面那张卡」的仲裁

   内核那侧在 `electron/core/clarify.cjs`（校验）、`clarify-timeout.cjs`（离场超时）。
   这里只干两件事：把答复拼成回话、决定输入框上方**显示哪一张卡**。
   ══════════════════════════════════════════════════════════════ */

/**
 * 用户答复 → 回给主进程的 JSON 字符串。
 *
 * 为什么走字符串：`chat:confirm` 那条通道本来就传布尔，加一个字符串参数最省
 * （**不开新通道**）；内核那边解析失败会当「跳过」处理，不会把任务卡住。
 */
export function clarifyReplyToWire(reply: ClarifyReply): string {
  const skipped = reply.skipped === true
  return JSON.stringify({
    skipped,
    /*
     * 跳过就把答案清掉：内核那边拿到 skipped 本来也不会用答案，但**半截答案**
     * 留在回话里会诱导后来的人写出「既跳过又用答案」的逻辑（今天还没有，明天会有）。
     */
    answers: reply.answers.map((one) => ({
      question: String(one.question ?? ''),
      choice: skipped ? '' : String(one.choice ?? ''),
      text: skipped ? '' : String(one.text ?? '').slice(0, 400),
    })),
  })
}

/** 这份答复算「答了」吗（至少选了一个选项，或写了至少一个字） */
export function clarifyAnswered(reply: ClarifyReply): boolean {
  return reply.answers.some((one) => Boolean(one.choice) || Boolean(one.text.trim()))
}

/** 历史只读卡上那句「当时选了什么、为什么」（AG-053 批③用） */
export function summarizeClarify(
  questions: readonly ClarifyQuestion[],
  reply: ClarifyReply,
): string[] {
  if (reply.skipped) return ['这次跳过了，由 Agent 自己判断']
  const byQuestion = new Map(reply.answers.map((one) => [one.question, one]))
  return questions.map((item) => {
    const answer = byQuestion.get(item.question)
    const choice = answer?.choice || '（没选）'
    const chosen = item.options.find((one) => one.label === choice)
    return `${item.question} → ${choice}${chosen?.effect ? `（因为：${chosen.effect}）` : ''}`
  })
}

/* ══════════════════════════════════════════════════════════════
   输入框上方只显示一张卡（AG-053 的补充【C】）
   ══════════════════════════════════════════════════════════════ */

export interface AboveInputState {
  /** 权限确认条在等用户（内核发起的那个，超时 5 分钟算拒绝） */
  permission: boolean
  /** 澄清卡在等用户 */
  clarify: boolean
}

export type AboveInputWinner = 'permission' | 'clarify' | null

/**
 * 谁显示？
 *
 * ★ **澄清让权限**（2026-10-01 定的）：权限那条往返有 **5 分钟超时，超时按拒绝**，
 *   让澄清卡把它压在后面，用户慢慢答澄清就会把一次正常的写操作压成「被拒绝」。
 *   所以：
 *     · 权限在场 → 显示权限，澄清**排队**（还挂在界面上，只是不显示）；
 *     · 权限不在、澄清在 → 显示澄清；
 *     · 都不在 → 什么都不显示。
 *
 * ⚠️ 「排队」不是卸载：组件照旧挂着（用 `hidden` 收起来），否则用户勾了一半的
 *   选项会在权限弹窗出现时被清空 —— 那是另一种形式的丢数据。
 */
export function pickAboveInput(state: AboveInputState): AboveInputWinner {
  if (state.permission) return 'permission'
  if (state.clarify) return 'clarify'
  return null
}
