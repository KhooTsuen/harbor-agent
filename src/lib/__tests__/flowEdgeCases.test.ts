import { describe, expect, it } from 'vitest'
import { advanceFlow, purposeOf, type ConversationFlow } from '../conversationFlow'

/* ══════════════════════════════════════════════════════════════
   第二阶段的两个关键反例

   ① 明确的答复片段 → 工具 → 最终定稿
      要证明：工具前那段**已明确归属答复**的文字，在工具调用后仍属于答复。

   ② 只有计划性发言，模型却正常停止（finish_reason: stop）
      要证明：stop 只说明「模型停止生成」，不是验收通过，也不该把
      「我接下来会跑测试」这种话当已确认的正式交付。
   ══════════════════════════════════════════════════════════════ */

const fresh = (): ConversationFlow => ({ version: 2, turn: 0, nodes: [] })
const run = (events: Record<string, unknown>[]) => events.reduce(advanceFlow, fresh())
const speech = (flow: ConversationFlow) =>
  flow.nodes
    .filter((n) => n.kind === 'speech')
    .map((n) => ({ text: n.text, purpose: purposeOf(n) }))

describe('反例① 答复片段 → 工具 → 最终定稿', () => {
  it('工具前那段已明确是答复的文字，调工具后仍属于答复（不被降级）', () => {
    const flow = run([
      { type: 'turn_start' },
      /* 已明确归属答复的一段（上层明确给了答复阶段信号） */
      { type: 'content', text: '答复片段：答案已经在这里。', stage: 'answer' },
      { type: 'agent.tool.started', toolCallId: 'verify-1' },
      { type: 'agent.tool.completed', toolCallId: 'verify-1', ok: true, result: 'ok' },
      { type: 'content', text: '补一句。' },
      { type: 'done', finalContent: '答复片段：答案已经在这里。 补一句。' },
    ])
    /* 关键：第一段不能被降级成 chatter，最终只结算一份 */
    expect(speech(flow)[0].text).toBe('答复片段：答案已经在这里。')
    expect(speech(flow)[0].purpose).not.toBe('chatter')
    expect(flow.final).toBe('答复片段：答案已经在这里。 补一句。')
  })

  it('普通文本（没有明确答复信号）调工具后按事实降级成过程发言', () => {
    const flow = run([
      { type: 'turn_start' },
      { type: 'content', text: '我先看看这两个文件。' },
      { type: 'agent.tool.started', toolCallId: 'read-1' },
      { type: 'done', finalContent: '结论：没问题。' },
    ])
    expect(speech(flow)[0]).toEqual({ text: '我先看看这两个文件。', purpose: 'chatter' })
    expect(flow.final).toBe('结论：没问题。')
  })
})

describe('反例② 只有计划性发言 + finish_reason: stop', () => {
  it('干过工具但没交付正文 + stop → 不得把计划话认成正式答复', () => {
    const flow = run([
      { type: 'turn_start' },
      { type: 'content', text: '我接下来会跑测试。' },
      { type: 'agent.tool.started', toolCallId: 'run-test' },
      { type: 'agent.tool.completed', toolCallId: 'run-test', ok: true, result: '' },
      { type: 'done', finishReason: 'stop' },
    ])
    /* 关键：没有最终正文、又确实干过活 → 不能凭空认成正式答复 */
    expect(flow.final).toBeUndefined()
    expect(speech(flow).some((s) => s.purpose === 'final')).toBe(false)
  })

  it('纯聊天（一次工具都没调）+ stop → 那段话就是答复，允许结算', () => {
    const flow = run([
      { type: 'turn_start' },
      { type: 'content', text: '1 + 1 等于 2。' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(speech(flow)[0]).toEqual({ text: '1 + 1 等于 2。', purpose: 'final' })
  })
})
