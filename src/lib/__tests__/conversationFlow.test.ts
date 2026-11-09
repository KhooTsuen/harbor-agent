import { describe, expect, it } from 'vitest'
import {
  advanceFlow,
  conversationFlowSchema,
  purposeOf,
  FLOW_VERSION,
  type ConversationFlow,
} from '../conversationFlow'

/* ⚠️ 2026-11-09 契约变更：`done` 不再**删掉**最后一轮的正文节点，
   而是把它留在轨迹里、标 `purpose: 'final'`；`final` 字段是那段文字的镜像。
   为什么改：收尾门禁把任务顶回去、让模型再干活时，被删掉的答复就找不回来了
   （"这段属于哪一轮、什么用途"无从回答）。断言随之改成按 `purpose` 判。 */

function run(events: Record<string, unknown>[]): ConversationFlow {
  return events.reduce<ConversationFlow>(advanceFlow, { version: FLOW_VERSION, turn: 0, nodes: [] })
}

describe('conversation flow', () => {
  it('keeps tool order and settles the final turn (node kept, marked final)', () => {
    const flow = run([
      { type: 'turn_start' },
      { type: 'content', text: 'A' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'content', text: 'B' },
      { type: 'turn_start' },
      { type: 'content', text: 'draft' },
      { type: 'done', finalContent: 'Final answer' },
    ])
    /* 顺序保住：过程话 → 工具 → 过程话 → 正式答复（节点不删，用途分得清） */
    expect(flow.nodes.map((node) => node.kind)).toEqual(['speech', 'tool', 'speech', 'speech'])
    expect(flow.nodes.filter((node) => node.kind === 'speech').map(purposeOf)).toEqual([
      'chatter',
      'chatter',
      'final',
    ])
    expect(flow.final).toBe('Final answer')
    expect(conversationFlowSchema.parse(JSON.parse(JSON.stringify(flow)))).toEqual(flow)
  })

  it('retains a retry in process and does not settle exhausted output', () => {
    const events = [
      { type: 'content', text: 'failed draft' },
      { type: 'retry' },
      { type: 'content', text: 'working again' },
    ]
    /* 重试掉的那段留在轨迹里、标过程；重试后的那段结算成正式答复 */
    const settled = run([...events, { type: 'done', finalContent: 'working again' }])
    expect(settled.nodes.filter((node) => node.kind === 'speech').map(purposeOf)).toEqual([
      'chatter',
      'final',
    ])
    expect(settled.final).toBe('working again')
    /* 轮数用尽 → 不结算（final 不出现），那段标未确认 */
    const exhausted = run([...events, { type: 'done', exhausted: true, finalContent: 'budget' }])
    expect(exhausted.final).toBeUndefined()
    expect(exhausted.nodes.filter((node) => node.kind === 'speech').map(purposeOf)).toEqual([
      'chatter',
      'unconfirmed',
    ])
  })
})
