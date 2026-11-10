import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types'
import type { CollaborationRecord } from '@/types/collaboration'
import { advanceFlow, type ConversationFlow } from '../conversationFlow'
import { bodyTextOf } from '../bodyText'
import { fullRecordText } from '../export'
import { handleStreamEvent, type StreamState } from '@/stores/thread/streamEvents'
import { mergeReplySnapshot, snapshotReply } from '@/stores/thread/replySnapshot'
import { markRoundStart } from '@/stores/thread/retryRollback'
import { collaborationSchema } from '@/types/collaboration'

const { scrubStorage, scrub, remember, forget } = require('../../../electron/core/redact.cjs') as {
  scrubStorage: (value: unknown) => unknown
  scrub: (value: unknown) => unknown
  remember: (value: string) => void
  forget: (value: string) => void
}

const role = { kind: 'openai' as const, providerId: 'provider', model: 'model', label: '模型' }
const record = (answer: string): CollaborationRecord => ({
  version: 1,
  id: 'exec',
  taskId: 'task',
  mode: 'supervised',
  roles: { planner: role, executor: role },
  status: 'paused',
  phase: 'review',
  stages: [],
  finalAnswer: answer,
})
const blank = (): ConversationFlow => ({ version: 2, turn: 0, nodes: [] })
const message = (flow?: ConversationFlow): Message => ({
  id: 'message',
  threadId: 'thread',
  role: 'assistant',
  content: '',
  reasoning: '',
  timestamp: 1,
  kind: 'text',
  status: 'streaming',
  flow,
})

describe('explicit collaboration body settlement', () => {
  it('settles a paused partial answer once and leaves B drafts in the process', () => {
    const answer = '> 尚未完成全部检查\n\nA 整理的有依据阶段成果'
    const draft = advanceFlow(blank(), { type: 'content', stage: 'process', text: 'B 的阶段稿' })
    const event = {
      type: 'done',
      paused: true,
      finalContent: answer,
      collaboration: record(answer),
    }
    const flow = advanceFlow(draft, event)
    expect(flow.nodes[0]).toMatchObject({ text: 'B 的阶段稿', purpose: 'chatter' })
    expect(flow.nodes.at(-1)).toMatchObject({ text: answer, purpose: 'final' })
    expect(bodyTextOf(message(flow))).toBe(answer)
    expect(fullRecordText(message(flow)).match(/A 整理的有依据阶段成果/g)).toHaveLength(1)
    expect(advanceFlow(flow, event)).toBe(flow)
  })

  it('does not settle an unbound answer, invalid state or a running collaboration', () => {
    const flow = advanceFlow(blank(), { type: 'content', stage: 'process', text: 'B 草稿' })
    for (const collaboration of [
      record('别的答案'),
      { ...record('A 答案'), status: 'running' },
      {},
    ]) {
      expect(
        advanceFlow(flow, {
          type: 'done',
          paused: true,
          finalContent: 'A 答案',
          collaboration,
        }).final,
      ).toBeUndefined()
    }
    expect(
      advanceFlow(blank(), { type: 'done', paused: true, finalContent: '单模型未结算片段' }).final,
    ).toBeUndefined()
  })
})

describe('terminal metadata independent of the UI placeholder', () => {
  it('keeps valid numeric usage through both live and disk redaction without exempting credentials', () => {
    const value = {
      ...record('A 答案'),
      limits: { maxRounds: 3, maxRuntime: 900, maxTokens: 0 },
      usage: { knownTokens: 1200, unknownCalls: 0 },
    }
    for (const sanitize of [scrubStorage, scrub]) {
      expect(collaborationSchema.safeParse(sanitize(value)).success).toBe(true)
      expect(sanitize({ maxTokens: 'secret-value', knownTokens: -1, token: 1200 })).toEqual({
        maxTokens: expect.any(String),
        knownTokens: expect.any(String),
        token: expect.any(String),
      })
    }
    remember('12345678')
    try {
      expect(scrubStorage({ knownTokens: 12345678 })).toEqual({ knownTokens: expect.any(String) })
    } finally {
      forget('12345678')
    }
  })

  it('recovers final collaboration from done when no phase event was received', () => {
    const answer = 'A 明确交付的阶段答复'
    const patch = vi.fn()
    const state: StreamState = {
      nativeFlow: true,
      flow: blank(),
      expectedCollaboration: true,
      content: 'B 草稿',
      reasoning: '',
      toolRuns: [],
      rounds: [],
      citations: [],
      patch,
      threadId: 'thread',
      finish: vi.fn(),
      retryMarks: markRoundStart('', '', []),
      snapshot: () => snapshotReply(message(), state),
    }
    handleStreamEvent(
      {
        type: 'done',
        paused: true,
        content: answer,
        finalContent: answer,
        requestId: 'exec',
        collaboration: record(answer),
      },
      state,
    )
    expect(state.collaboration).toEqual(record(answer))
    expect(state.content).toBe(answer)
    expect(state.snapshot()).toMatchObject({
      content: answer,
      collaboration: record(answer),
      status: 'sent',
    })
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ collaboration: record(answer) }))
  })

  it('preserves stream tools, flow, terminal status and UI receipts with a stale store entry', () => {
    const base = message()
    const flow = { ...blank(), final: 'A 答案' }
    const snapshot = {
      ...base,
      content: 'A 答案',
      flow,
      collaboration: record('A 答案'),
      status: 'sent' as const,
      verdict: 'partial' as const,
      interrupted: true,
      toolRuns: [{ id: 'call', name: 'browse', ok: true, output: '实际正文' }],
    }
    const stored = { ...base, inputReplies: [] }
    const merged = mergeReplySnapshot(stored, snapshot)
    expect(merged).toMatchObject({
      content: 'A 答案',
      status: 'sent',
      verdict: 'partial',
      interrupted: true,
      collaboration: record('A 答案'),
      toolRuns: snapshot.toolRuns,
      inputReplies: [],
      flow,
    })
    expect(mergeReplySnapshot(undefined, snapshot)).toEqual(snapshot)
  })
})
