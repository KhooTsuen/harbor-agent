import { describe, expect, it } from 'vitest'
import { advanceFlow, conversationFlowSchema, type ConversationFlow } from '../conversationFlow'

function project(events: Record<string, unknown>[]) {
  return events.reduce<ConversationFlow>(advanceFlow, { version: 1, turn: 0, nodes: [] })
}

describe('conversation flow', () => {
  it('keeps tool order and settles only the final turn', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: 'A' },
      { type: 'agent.tool.started', toolCallId: 'read' },
      { type: 'content', text: 'B' },
      { type: 'turn_start' },
      { type: 'content', text: 'draft' },
      { type: 'done', finalContent: 'Final answer' },
    ])
    expect(flow.nodes.map((node) => node.kind)).toEqual(['speech', 'tool', 'speech'])
    expect(flow.final).toBe('Final answer')
    expect(conversationFlowSchema.parse(JSON.parse(JSON.stringify(flow)))).toEqual(flow)
  })

  it('retains a retry in process and does not settle exhausted output', () => {
    const events = [
      { type: 'content', text: 'failed draft' },
      { type: 'retry' },
      { type: 'content', text: 'working again' },
    ]
    expect(
      project([...events, { type: 'done', finalContent: 'working again' }]).nodes,
    ).toMatchObject([{ text: 'failed draft' }])
    expect(
      project([...events, { type: 'done', exhausted: true, finalContent: 'budget' }]).final,
    ).toBeUndefined()
  })
})
