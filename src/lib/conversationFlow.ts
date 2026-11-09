import { z } from 'zod'

const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('speech'), id: z.number(), turn: z.number(), text: z.string() }),
  z.object({ kind: z.literal('reasoning'), id: z.number(), turn: z.number(), text: z.string() }),
  z.object({ kind: z.literal('tool'), id: z.number(), turn: z.number(), toolId: z.string() }),
])

export const conversationFlowSchema = z.object({
  version: z.literal(1),
  turn: z.number(),
  nodes: z.array(nodeSchema),
  final: z.string().optional(),
})

export type ConversationFlow = z.infer<typeof conversationFlowSchema>

export function advanceFlow(
  flow: ConversationFlow,
  event: Record<string, unknown>,
): ConversationFlow {
  const type = event.type
  const { nodes, turn } = flow
  const id = nodes.length
  if (type === 'turn_start') return { ...flow, turn: turn + 1 }
  if (type === 'retry') return { ...flow, turn: turn + 1 }
  if (
    (type === 'agent.tool.started' ||
      type === 'agent.tool.completed' ||
      type === 'agent.tool.failed') &&
    typeof event.toolCallId === 'string' &&
    !nodes.some((node) => node.kind === 'tool' && node.toolId === event.toolCallId)
  ) {
    return { ...flow, nodes: [...nodes, { kind: 'tool', id, turn, toolId: event.toolCallId }] }
  }
  if ((type === 'content' || type === 'reasoning') && typeof event.text === 'string') {
    const kind = type === 'content' ? 'speech' : 'reasoning'
    const last = nodes.at(-1)
    if (last?.kind === kind && last.turn === turn) {
      return { ...flow, nodes: [...nodes.slice(0, -1), { ...last, text: last.text + event.text }] }
    }
    return { ...flow, nodes: [...nodes, { kind, id, turn, text: event.text }] }
  }
  if (type === 'done' && typeof event.finalContent === 'string') {
    if (event.exhausted || event.paused || event.truncated || !event.finalContent.trim())
      return flow
    return {
      ...flow,
      nodes: nodes.filter((node) => node.kind !== 'speech' || node.turn !== turn),
      final: event.finalContent,
    }
  }
  return flow
}
