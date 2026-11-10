import type { AgentPhase, Message, MessageRound, ToolRunRecord } from '@/types'
import { isToolFailure } from '@/types/rounds'
import { advanceFlow, FLOW_VERSION, type ConversationFlow } from '@/lib/conversationFlow'
import { uid } from '@/lib/utils'
import { useAppStore } from '../useAppStore'
import { usePerfStore } from '../usePerfStore'
import { summarizeArgs } from './parseToolOutput'
import { applyToolProgress } from './toolProgress'
import { applySubagentEvent } from './subagentEvents'
import { citationsOf } from './toolCitations'
import { handleAttachmentEvent } from './attachmentEvents'
import { reconcileFinalRounds } from './finalRounds'
import { applyPauseAfterTurn, discardConfirmationPause } from './confirmationPause'
import { handleCardEvent } from './cardEvents'
import { logAction, logError } from '@/lib/actionLog'
import { endedNow } from './turnTiming'
import { refreshAfterTool } from './toolRefresh'
import { dispatchLightEvent } from './streamLight'
import { markRoundStart, type RetryMarks } from './retryRollback'
import { inputOfEvent } from './contextUsage'
import { applyRetryLink, applyRetryNotice } from './toolRetry'
import { handleCollaborationEvent, readCollaboration } from './collaborationEvents'

export interface StreamState {
  nativeFlow?: boolean
  flow?: ConversationFlow
  collaboration?: Message['collaboration']
  expectedCollaboration?: boolean
  execTaskId?: string
  terminal?: Partial<Message>
  content: string
  reasoning: string
  toolRuns: ToolRunRecord[]
  rounds: MessageRound[]
  citations: NonNullable<Message['citations']>
  patch: (fields: Partial<Message>) => void
  snapshot: () => Message
  finish: () => void
  threadId: string
  retryMarks: RetryMarks
}
function currentRound(state: StreamState): MessageRound {
  const last = state.rounds[state.rounds.length - 1]
  if (last) return last
  const fresh: MessageRound = { reasoning: '', content: '', tools: [] }
  state.rounds.push(fresh)
  state.retryMarks = markRoundStart(state.content, state.reasoning, state.rounds)
  return fresh
}
function syncRounds(state: StreamState): MessageRound[] {
  return [...state.rounds]
}
function runSafely(where: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    logError(`stream.${where}`, error)
  }
}
function isLifecycleEvent(type: string): boolean {
  if (type === 'phase') return true
  return type.startsWith('agent.') && !type.startsWith('agent.tool.')
}
export function handleStreamEvent(
  event: Record<string, unknown>,
  state: StreamState,
): { handled: boolean; notifyDone?: boolean } {
  const type = String(event.type ?? '')
  if (
    handleCollaborationEvent(event, state.patch, (record) => {
      state.collaboration = record
    })
  )
    return { handled: true }
  if (type === 'agent.retrying') {
    if (applyRetryNotice(state.toolRuns, event)) state.patch({ toolRuns: [...state.toolRuns] })
    return { handled: true }
  }
  if (isLifecycleEvent(type)) {
    const phase = String(event.phase ?? '') as AgentPhase
    if (phase) {
      state.patch({ phase })
      useAppStore.getState().setThreadPhase(state.threadId, phase)
    }
    return { handled: true }
  }

  if (state.nativeFlow) {
    const next = advanceFlow(state.flow ?? { version: FLOW_VERSION, turn: 0, nodes: [] }, event)
    if (next !== state.flow) {
      state.flow = next
      runSafely('flow.patch', () => state.patch({ flow: next }))
    }
  }

  switch (type) {
    case 'content': {
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      const round = state.flow ? undefined : currentRound(state)
      state.content += String(event.text ?? '')
      if (round) round.content += String(event.text ?? '')
      state.patch({ content: state.content, rounds: syncRounds(state) })
      return { handled: true }
    }

    case 'reasoning': {
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      const round = state.flow ? undefined : currentRound(state)
      state.reasoning += String(event.text ?? '')
      if (round) round.reasoning += String(event.text ?? '')
      state.patch({ reasoning: state.reasoning, rounds: syncRounds(state) })
      return { handled: true }
    }
    case 'agent.tool.started': {
      const record: ToolRunRecord = {
        id: String(event.toolCallId ?? uid('tool')),
        name: String(event.name ?? '未知工具'),
        sourcePath:
          typeof (event.args as Record<string, unknown> | undefined)?.path === 'string'
            ? String((event.args as Record<string, unknown>).path)
            : undefined,
        summary: summarizeArgs(
          String(event.name ?? ''),
          (event.args ?? {}) as Record<string, unknown>,
        ),
        ok: true,
        pending: true,
        output: '',
      }
      state.toolRuns.push(record)
      applyRetryLink(state.toolRuns, record, event.retryOf)
      if (!state.flow) currentRound(state).tools.push(state.toolRuns.length - 1)
      state.patch({ toolRuns: [...state.toolRuns], rounds: syncRounds(state) })
      return { handled: true }
    }
    case 'agent.tool.progress': {
      if (applyToolProgress(state.toolRuns, event)) {
        state.patch({ toolRuns: [...state.toolRuns] })
      }
      return { handled: true }
    }
    case 'subagent.step': {
      if (applySubagentEvent(state.toolRuns, event)) state.patch({ toolRuns: [...state.toolRuns] })
      return { handled: true }
    }

    case 'agent.tool.completed':
    case 'agent.tool.failed': {
      const id = String(event.toolCallId ?? '')
      const index = state.toolRuns.findIndex((run) => run.id === id)
      const output = String(event.result ?? '')
      const failure = isToolFailure(event.error) ? { error: event.error } : {}
      const updated: ToolRunRecord = {
        ...state.toolRuns[index] /* 保住 subagent trace（重建新对象会把它抹掉） */,
        id,
        name: String(event.name ?? '未知工具'),
        ok: event.ok !== false && type !== 'agent.tool.failed',
        output,
        ms: typeof event.ms === 'number' ? event.ms : undefined,
        ...failure,
      }
      delete updated.pending
      delete updated.progress
      if (updated.ok) delete updated.error
      if (
        typeof event.retryAttempt === 'number' &&
        Number.isSafeInteger(event.retryAttempt) &&
        event.retryAttempt > 0
      )
        updated.retryAttempt = event.retryAttempt
      if (index >= 0) state.toolRuns[index] = updated
      else state.toolRuns.push(updated)
      applyRetryLink(state.toolRuns, updated, event.retryOf)
      refreshAfterTool()
      const cited = updated.ok ? citationsOf(event, output, updated) : []
      if (cited.length > 0) {
        state.citations.push(...cited)
        state.patch({ citations: [...state.citations] })
      }
      state.patch({ toolRuns: [...state.toolRuns], rounds: syncRounds(state) })
      return { handled: true }
    }
    case 'confirm_request':
    case 'clarify.timeout':
    case 'confirm.timeout':
      return { handled: handleCardEvent(event, type) }
    case 'task':
      if (event.taskId) {
        state.execTaskId = String(event.taskId)
        state.patch({ execTaskId: state.execTaskId })
      }
      return { handled: true }
    case 'turn_start': {
      if (!state.flow) state.rounds.push({ reasoning: '', content: '', tools: [] })
      state.retryMarks = markRoundStart(state.content, state.reasoning, state.rounds)
      /* 立刻挂到消息上 —— 否则新的一轮要等它出了第一个字才在界面上出现。
         P1-B：第一轮的 `turn_start` 还带 `input`（内核实际组装完的量），一起挂上。 */
      state.patch({ rounds: syncRounds(state), ...inputOfEvent(event) })
      return { handled: true }
    }
    case 'done': {
      runSafely('done.finish', () => state.finish())
      const finalContent = String(event.content ?? '') || state.content
      state.content = finalContent
      state.reasoning = String(event.reasoning ?? '') || state.reasoning
      if (event.collaboration !== undefined)
        state.collaboration = readCollaboration(event.collaboration, 'done') ?? state.collaboration
      if (state.collaboration)
        logAction('collaboration.done', `${state.collaboration.id}:${state.collaboration.status}`)
      else if (state.expectedCollaboration)
        logError('collaboration.done.missing', String(event.requestId ?? ''))
      if (!state.flow) state.rounds = reconcileFinalRounds(state.rounds, finalContent)
      state.terminal = {
        content: finalContent,
        ...(state.collaboration ? { collaboration: state.collaboration } : {}),
        reasoning: String(event.reasoning ?? '') || state.reasoning,
        durationMs: endedNow(state),
        usage: (event.usage ?? undefined) as Message['usage'],
        toolRuns: [...state.toolRuns],
        rounds: state.rounds.map((round) => ({ ...round, tools: [...round.tools] })),
        citations: [...state.citations],
        status: 'sent',
        ...(state.flow && (event.exhausted || event.paused) ? { interrupted: true } : {}),
        kind: 'text',
        ...(event.truncated ? { truncated: event.truncated as Message['truncated'] } : {}),
        ...(event.verdict ? { verdict: event.verdict as Message['verdict'] } : {}),
      }
      runSafely('done.patch', () => state.patch(state.terminal ?? {}))
      runSafely('done.pauseAfterTurn', () => applyPauseAfterTurn(String(event.requestId ?? '')))
      return { handled: true, notifyDone: true }
    }

    case 'aborted': {
      discardConfirmationPause(String(event.requestId ?? ''))
      runSafely('aborted.finish', () => state.finish())
      state.terminal = {
        status: 'sent',
        content: state.content,
        interrupted: true,
        durationMs: endedNow(state),
        rounds: syncRounds(state),
      }
      runSafely('aborted.patch', () => state.patch(state.terminal ?? {}))
      return { handled: true }
    }

    case 'error': {
      discardConfirmationPause(String(event.requestId ?? ''))
      const message = String(event.message ?? '未知错误')
      runSafely('error.finish', () => state.finish())
      state.terminal = {
        status: 'error',
        kind: 'error',
        errorText: message,
        content: message,
        durationMs: endedNow(state),
      }
      runSafely('error.patch', () => state.patch(state.terminal ?? {}))
      return { handled: true }
    }
    case 'attachment': {
      runSafely('attachment', () => handleAttachmentEvent(state.threadId, event))
      return { handled: true }
    }
    case 'retry':
    case 'boundary':
    case 'budget':
    case 'notice':
    case 'fallback':
    case 'context_overflow':
      return { handled: dispatchLightEvent(type, event, state) }
    case 'plan': {
      refreshAfterTool()
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}
