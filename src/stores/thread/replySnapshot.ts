import type { Message } from '@/types'
import type { StreamState } from './streamEvents'

export function snapshotReply(placeholder: Message, state: StreamState): Message {
  return {
    ...placeholder,
    ...state.terminal,
    content: state.content,
    reasoning: state.reasoning,
    toolRuns: state.toolRuns,
    citations: state.citations,
    rounds: state.rounds,
    flow: state.flow,
    collaboration: state.collaboration,
    execTaskId: state.execTaskId,
  }
}

/** Stream accumulators preserve execution data when the UI message is replaced. */
export function mergeReplySnapshot(stored?: Message, snapshot?: Message): Message | undefined {
  if (!snapshot) return stored
  return {
    ...snapshot,
    ...stored,
    ...(snapshot.status === 'sent' || snapshot.status === 'error'
      ? {
          status: snapshot.status,
          kind: snapshot.kind,
          errorText: snapshot.errorText,
          durationMs: snapshot.durationMs,
          usage: snapshot.usage,
          interrupted: snapshot.interrupted,
          truncated: snapshot.truncated,
          verdict: snapshot.verdict,
        }
      : {}),
    content: snapshot.content,
    reasoning: snapshot.reasoning,
    toolRuns: snapshot.toolRuns,
    rounds: snapshot.rounds,
    citations: snapshot.citations,
    ...(snapshot.flow ? { flow: snapshot.flow } : {}),
    ...(snapshot.collaboration ? { collaboration: snapshot.collaboration } : {}),
    ...(snapshot.execTaskId ? { execTaskId: snapshot.execTaskId } : {}),
  }
}
