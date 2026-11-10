import { describe, expect, it } from 'vitest'
import type { Message, ToolRunRecord } from '@/types'
import { toAnswerRecord, answerPatch } from '../answers'
import { StoredMessageSchema } from '../schemas'
import { storedToUi } from '@/stores/app/disk'
import { citationTarget, referenceTarget } from '../citationTargets'
import { citationsOf } from '@/stores/thread/toolCitations'
import { applyRetryLink, applyRetryNotice } from '@/stores/thread/toolRetry'

const { retryLink } = require('../../../electron/core/tool-retry-link.cjs') as {
  retryLink: (
    runs: Record<string, unknown>[],
    call: { name: string; id: string },
    args: Record<string, unknown>,
  ) => { retryOf?: string }
}
const message = (): Message => ({
  id: 'answer',
  diskKey: 'disk-answer',
  threadId: 'thread',
  role: 'assistant',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  content: 'result',
  execId: 'exec',
  flow: { version: 2, turn: 1, nodes: [{ kind: 'tool', id: 1, turn: 1, toolId: 'call' }] },
})

describe('UI gap persistence and source navigation', () => {
  it('receipts, source links and artifacts survive serialization and version selection', () => {
    const original = message()
    original.inputReplies = [
      {
        confirmId: 'confirm',
        execId: 'exec',
        title: 'allow',
        details: ['deny'],
        state: 'accepted',
        at: 2,
      },
    ]
    original.artifacts = [
      { id: 'file', name: 'a.txt', path: 'a.txt', type: 'generated_file', createdAt: 2 },
    ]
    original.citations = [
      { id: 'source', kind: 'file', title: 'a.txt', sourceToolId: 'call', sourceExecId: 'exec' },
    ]
    const stored = toAnswerRecord(original)
    const decoded = StoredMessageSchema.parse(JSON.parse(JSON.stringify(stored)))
    const restored = storedToUi(
      {
        ...stored,
        inputReplies: decoded.inputReplies,
        artifacts: decoded.artifacts,
        citations: decoded.citations,
      },
      'thread',
    )
    expect(restored.inputReplies).toEqual(original.inputReplies)
    expect(restored.artifacts).toEqual(original.artifacts)
    expect(citationTarget(restored, restored.citations![0])).toBe(`flow-node-${restored.id}-1`)
    expect(answerPatch({ role: 'assistant', content: 'old' }, 0)).toMatchObject({
      inputReplies: [],
      artifacts: [],
      citations: [],
    })
  })

  it('requires recorded provenance in the selected execution, including fragment links', () => {
    const selected = message()
    selected.citations = [
      { id: 'source', kind: 'web', title: 'source', sourceToolId: 'call', sourceExecId: 'exec' },
    ]
    expect(referenceTarget(selected, '#cite-1')).toBe('flow-node-answer-1')
    expect(referenceTarget(selected, '#cite-99')).toBeUndefined()
    expect(referenceTarget(selected, '#cite-%broken')).toBeUndefined()
    expect(referenceTarget(selected, '#flow-node-other-1')).toBeUndefined()
    expect(citationTarget({ ...selected, execId: 'other' }, selected.citations[0])).toBeUndefined()
    expect(citationTarget(selected, { id: 'old', kind: 'file', title: 'a.txt' })).toBeUndefined()
  })

  it('file citations retain the started call path when completion omits args', () => {
    const [citation] = citationsOf(
      { name: 'read_file', toolCallId: 'call', requestId: 'exec' },
      'text',
      {
        id: 'call',
        name: 'read_file',
        sourcePath: 'a.txt',
        ok: true,
        output: 'text',
      },
    )
    expect(citation).toMatchObject({ path: 'a.txt', sourceToolId: 'call', sourceExecId: 'exec' })
  })
})

describe('retry identity and recovery', () => {
  it('links identical arguments independent of property order, within supplied execution history', () => {
    const runs = [{ id: 'old', name: 'read_file', args: { path: 'a', limit: 2 }, ok: false }]
    expect(retryLink(runs, { name: 'read_file', id: 'new' }, { limit: 2, path: 'a' })).toEqual({
      retryOf: 'old',
    })
    expect(retryLink(runs, { name: 'read_file', id: 'new' }, { path: 'b', limit: 2 })).toEqual({})
    expect(retryLink([], { name: 'read_file', id: 'new' }, { path: 'a', limit: 2 })).toEqual({})
    expect(
      retryLink(
        [...runs, { ...runs[0], id: 'success', ok: true }],
        { name: 'read_file', id: 'new' },
        { path: 'a', limit: 2 },
      ),
    ).toEqual({})
  })

  it('keeps failed facts and only marks recovery after linked success', () => {
    const old: ToolRunRecord = { id: 'old', name: 'read_file', ok: false, output: 'failed' }
    const retry: ToolRunRecord = {
      id: 'new',
      name: 'read_file',
      ok: true,
      pending: true,
      output: '',
    }
    const runs = [old, retry]
    applyRetryLink(runs, retry, 'old')
    expect(old.retryingBy).toBe('new')
    expect(old.recoveredBy).toBeUndefined()
    delete retry.pending
    applyRetryLink(runs, retry)
    expect(old).toMatchObject({ ok: false, output: 'failed', recoveredBy: 'new' })
    expect(old.retryingBy).toBeUndefined()
    expect(applyRetryNotice(runs, { toolCallId: 'unknown', attempt: 1 })).toBe(false)
    expect(applyRetryNotice(runs, { toolCallId: 'new', attempt: -1 })).toBe(false)
  })
})
