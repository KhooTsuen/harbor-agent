import type { ConversationFlow, FlowNode } from './conversationFlow'
import { collaborationSchema } from '@/types/collaboration'

/** An explicit supervisor delivery can be partial while execution remains paused. */
export function settleCollaboration(
  flow: ConversationFlow,
  event: Record<string, unknown>,
): ConversationFlow | undefined {
  const parsed = collaborationSchema.safeParse(event.collaboration)
  if (!parsed.success || parsed.data.mode !== 'supervised') return undefined
  const record = parsed.data
  const text = typeof event.finalContent === 'string' ? event.finalContent : ''
  if (
    !text.trim() ||
    text !== record.finalAnswer ||
    ['running', 'waiting_user'].includes(record.status)
  )
    return undefined
  if (flow.final === text) return flow
  const nodes: FlowNode[] = flow.nodes.map((node) =>
    node.kind === 'speech' ? { ...node, purpose: 'chatter', hold: false } : node,
  )
  const id = nodes.reduce((max, node) => Math.max(max, node.id), -1) + 1
  nodes.push({ kind: 'speech', id, turn: flow.turn, text, purpose: 'final' })
  return { ...flow, nodes, final: text }
}
