import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types'
import type { StoredMessage } from '@/types/models-session'
import type { ConfirmationAck } from '@/types/inputReply'
import * as backend from '@/lib/backend'
import * as chatControl from '@/lib/chatControl'
import * as safetyApi from '@/lib/safetyApi'
import { answerPatch, toAnswerRecord } from '@/lib/answers'
import { runInputCardAction } from '@/lib/inputCardAction'
import { useAppStore } from '../useAppStore'
import { recordInputReply, submitCardReply } from '../thread/inputReplies'
import { applyPauseAfterTurn, prepareConfirmationPause } from '../thread/confirmationPause'

const initial = useAppStore.getState()
let sequence = 0
const event = () => ({ sessionId: 'thread', requestId: 'exec', confirmId: `confirm-${++sequence}` })
const assistant = (): Message => ({
  id: 'answer',
  diskKey: 'disk-answer',
  threadId: 'thread',
  execId: 'exec',
  role: 'assistant',
  content: 'old answer',
  status: 'streaming',
  kind: 'text',
  timestamp: 1,
})
const current = () => useAppStore.getState().threads[0].messages[0]
const writes = vi.fn<(threadId: string, record: StoredMessage) => void>()

beforeEach(() => {
  writes.mockClear()
  useAppStore.setState({
    threads: [
      {
        id: 'thread',
        projectId: 'project',
        title: 'thread',
        messages: [assistant()],
        status: 'idle',
        mode: 'pair',
        model: 'model',
        reasoning: 'high',
        pinned: false,
        archived: false,
        tags: [],
        exportedAt: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeThreadId: 'thread',
    persistMessage: writes,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

describe('backend input receipt ownership', () => {
  it('a delayed acknowledgement updates only its originating answer after version selection', async () => {
    let acknowledge!: (result: ConfirmationAck) => void
    vi.spyOn(backend, 'confirmChat').mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    )
    const source = event()
    const submitting = submitCardReply(source, true, ['allow'])
    expect(current().inputReplies?.[0].state).toBe('submitting')
    const original = toAnswerRecord(current())
    const next: StoredMessage = {
      role: 'assistant',
      content: 'new answer',
      key: 'next',
      execId: 'next-exec',
    }
    useAppStore.getState().updateMessage('thread', 'answer', {
      ...answerPatch(next, 1),
      answerRecords: [original, next],
    })
    acknowledge({ ok: true })
    await submitting
    expect(current()).toMatchObject({ execId: 'next-exec', inputReplies: [] })
    expect(current().answerRecords?.[0].inputReplies?.[0]).toMatchObject({
      state: 'accepted',
      details: ['allow'],
    })
    expect(writes.mock.lastCall?.[1]).toMatchObject({
      key: 'disk-answer',
      execId: 'exec',
      inputReplies: [{ state: 'accepted' }],
    })
  })

  it('rejected or expired replies remain failed and permit a new submission', async () => {
    vi.spyOn(backend, 'confirmChat')
      .mockResolvedValueOnce({ ok: false, error: '已过期' })
      .mockResolvedValueOnce({ ok: true })
    const source = event()
    expect((await submitCardReply(source, true, ['first'])).ok).toBe(false)
    expect(current().inputReplies?.[0]).toMatchObject({ state: 'failed', error: '已过期' })
    await submitCardReply(source, true, ['retry'])
    expect(current().inputReplies).toHaveLength(1)
    expect(current().inputReplies?.[0]).toMatchObject({ state: 'accepted', details: ['retry'] })
  })

  it('duplicate close callbacks cannot overwrite an accepted answer', async () => {
    const send = vi.spyOn(backend, 'confirmChat').mockResolvedValue({ ok: true })
    const source = event()
    const first = submitCardReply(source, true, ['original'])
    const duplicate = submitCardReply(source, false, ['closed'])
    expect(duplicate).toBe(first)
    await first
    await submitCardReply(source, false, ['late close'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(current().inputReplies?.[0].details).toEqual(['original'])
  })

  it('does not attach an unknown execution to the latest assistant', () => {
    recordInputReply(event(), {
      confirmId: 'unknown',
      execId: 'other',
      title: 'x',
      details: [],
      state: 'accepted',
      at: 1,
    })
    expect(current().inputReplies).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
  })
})

describe('acknowledgement boundaries', () => {
  it('keeps legacy local callbacks distinct and catches rejected promises', async () => {
    expect(await runInputCardAction(() => {})).toEqual({ state: 'local' })
    expect(await runInputCardAction(async () => ({ ok: false, error: 'expired' }))).toEqual({
      state: 'failed',
      error: 'expired',
    })
    expect(
      await runInputCardAction(async () => {
        throw new Error('offline')
      }),
    ).toEqual({ state: 'failed', error: 'offline' })
  })

  it('retains cancellation intent if done precedes acknowledgement, applying it only once', async () => {
    vi.spyOn(chatControl, 'pauseChat').mockResolvedValue()
    const update = vi.spyOn(safetyApi, 'taskUpdate').mockResolvedValue()
    const source = { requestId: `pause-${++sequence}`, taskId: 'task' }
    const settle = await prepareConfirmationPause(source)
    applyPauseAfterTurn(source.requestId)
    expect(update).not.toHaveBeenCalled()
    settle(true)
    applyPauseAfterTurn(source.requestId)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ status: 'paused', pauseReason: 'user' }),
    )
  })

  it('does not relabel the task paused when the cancellation reply was rejected', async () => {
    vi.spyOn(chatControl, 'pauseChat').mockResolvedValue()
    const update = vi.spyOn(safetyApi, 'taskUpdate').mockResolvedValue()
    const source = { requestId: `pause-${++sequence}`, taskId: 'task' }
    const settle = await prepareConfirmationPause(source)
    applyPauseAfterTurn(source.requestId)
    settle(false)
    expect(update).not.toHaveBeenCalled()
  })
})
