import { describe, expect, it } from 'vitest'
import { collaborationSchema } from '@/types/collaboration'
import { toAnswerRecord, answerPatch } from '../answers'
import { storedToUi } from '@/stores/app/disk'
import { StoredMessageSchema } from '../schemas'
import {
  buildOptions,
  matchRole,
  defaultPair,
  collabReady,
  type Pickable,
} from '@/components/chat/composer/collabOptions'
import type { Message } from '@/types'
import type { ProviderConfig } from '@/types/models'

type Run = {
  id: string
  name: string
  args: Record<string, unknown>
  ok: boolean
  output: string
  pending?: boolean
}
type Trace = {
  writes: string[]
  tools: Run[]
  lastTest: { status: string; ok: boolean } | null
  changedAfterTest: boolean
}
type Review = { verdict: string; reasons: string[]; issues: string[] }
const { extractTrace } = require('../../../electron/core/collab-trace.cjs') as {
  extractTrace: (runs: Run[]) => Trace
}
const { incomplete, constrainReview } = require('../../../electron/core/collab-stages.cjs') as {
  incomplete: (result: Record<string, unknown>) => string[] | null
  constrainReview: (review: Review, trace: Trace) => Review
}
const { withModel } = require('../../../electron/core/collab-planner.cjs') as {
  withModel: (config: Record<string, unknown>, model: string, id: string) => Record<string, unknown>
}
const { historyContext } = require('../../../electron/core/collab-context.cjs') as {
  historyContext: (history: Array<{ role: string; content: unknown }>, limit?: number) => string
}
const run = (name: string, ok = true, output = '', args: Record<string, unknown> = {}): Run => ({
  id: name,
  name,
  ok,
  output,
  args,
})
const pass: Review = { verdict: 'PASS', reasons: ['model says done'], issues: [] }
const candidate = (key: string): Pickable => ({
  key,
  kind: 'openai',
  providerId: key,
  providerName: key,
  label: key,
  model: key,
  disabled: false,
  reason: '',
})

describe('collaboration evidence gates', () => {
  it('a model PASS requires an actual current successful test record', () => {
    expect(constrainReview(pass, extractTrace([])).verdict).toBe('BLOCKED')
    expect(
      constrainReview(pass, extractTrace([run('run_project_test', false, '[退出码 0]')])).verdict,
    ).toBe('BLOCKED')
    expect(
      constrainReview(pass, extractTrace([run('run_project_test', true, '[退出码 1]')])).verdict,
    ).toBe('BLOCKED')
    expect(
      constrainReview(pass, extractTrace([run('run_project_test', true, '[退出码 0]')])).verdict,
    ).toBe('PASS')
  })

  it('a later modification invalidates prior test evidence, including failed write attempts', () => {
    const tested = run('run_project_test', true, '[退出码 0]')
    expect(
      constrainReview(pass, extractTrace([tested, run('edit_file', true, '', { path: 'a.ts' })]))
        .verdict,
    ).toBe('BLOCKED')
    expect(
      constrainReview(pass, extractTrace([tested, run('edit_file', false, 'failed')])).verdict,
    ).toBe('BLOCKED')
    expect(constrainReview(pass, extractTrace([run('edit_file', true), tested])).verdict).toBe(
      'PASS',
    )
  })

  it('keeps unknown tool results and all successful proposal targets as evidence', () => {
    const pending = { ...run('read_file'), pending: true }
    const trace = extractTrace([
      run('apply_test_fix', true, '', { proposals: [{ path: 'a' }, { path: 'b' }] }),
      pending,
    ])
    expect(trace.writes).toEqual(['a', 'b'])
    expect(trace.tools[1]).toMatchObject({ ok: false, pending: true })
  })

  it('pauses, exhaustion and truncated output cannot enter complete-result review', () => {
    for (const result of [
      { paused: true },
      { exhausted: true },
      { truncated: 'length' },
      { finishReason: 'length' },
      { sawDone: false },
    ])
      expect(incomplete(result)).not.toBeNull()
    // Generic legacy development verdicts do not replace A's task-specific review.
    for (const verdict of ['done', 'partial', 'failed']) expect(incomplete({ verdict })).toBeNull()
  })

  it('pins the explicit provider and disables role routing and cross-provider fallback', () => {
    const providers = [
      { id: 'a', models: ['shared'], enabled: true },
      { id: 'b', models: ['shared'], enabled: true },
    ]
    const config = {
      providers,
      assistant: { model: 'other' },
      router: { enabled: true },
      fallback: { enabled: true, attempts: 2 },
    }
    expect(withModel(config, 'shared', 'b')).toMatchObject({
      _collabProviderId: 'b',
      assistant: { model: 'shared' },
      router: { enabled: false },
      fallback: { enabled: false, attempts: 2 },
    })
    expect(() => withModel(config, 'deleted', 'b')).toThrow()
    expect(config.fallback.enabled).toBe(true)
  })
})

describe('role selection and history', () => {
  it('does not present a deleted or incomplete role as the first available model', () => {
    expect(
      matchRole([candidate('a')], { kind: 'openai', model: 'missing', providerId: 'deleted' }),
    ).toBeUndefined()
    expect(matchRole([candidate('a')], { kind: 'openai', providerId: 'a' })).toBeUndefined()
  })

  it('finds a real assignable pair rather than counting the union or picking greedily', () => {
    const a = candidate('a'),
      b = candidate('b')
    expect(defaultPair([a, b], [a])).toEqual({ planner: b, executor: a })
    expect(collabReady([a, b], [])).toMatchObject({ ok: false })
  })

  it('disables the individual connection without credentials even when another API is ready', () => {
    const provider: ProviderConfig = {
      id: 'p',
      name: 'p',
      baseUrl: 'https://example.test',
      apiKey: '',
      chatPath: '',
      models: ['m'],
      enabled: true,
      hasKey: false,
      kind: 'openai',
    }
    expect(buildOptions([provider], ['openai'], { openai: true })[0].disabled).toBe(true)
  })

  it('persists collaboration with the original answer and clears it on an older answer', () => {
    const role = { kind: 'openai', providerId: 'p', model: 'm', label: 'p · m' }
    const collaboration = collaborationSchema.parse({
      version: 1,
      id: 'exec',
      taskId: 'task',
      roles: { planner: role, executor: { ...role, model: 'other' } },
      phase: 'execute',
      status: 'cancelled',
      stages: [],
      error: { code: 'CANCELLED', message: 'stopped' },
    })
    const original: Message = {
      id: 'answer',
      threadId: 'thread',
      role: 'assistant',
      content: 'partial',
      kind: 'text',
      status: 'sent',
      timestamp: 1,
      collaboration,
    }
    const stored = toAnswerRecord(original)
    const decoded = StoredMessageSchema.parse(JSON.parse(JSON.stringify(stored)))
    expect(
      storedToUi({ ...stored, collaboration: decoded.collaboration }, 'thread').collaboration,
    ).toEqual(collaboration)
    expect(answerPatch({ role: 'assistant', content: 'old' }, 0).collaboration).toBeUndefined()
    expect(
      collaborationSchema.safeParse({ ...collaboration, status: 'made-up-success' }).success,
    ).toBe(false)
  })

  it('bounds handoff context without serializing image bytes into text', () => {
    const text = historyContext(
      [
        { role: 'user', content: 'x'.repeat(20000) },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,secret-image' } },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
      500,
    )
    expect(text).toContain('continue')
    expect(text).not.toContain('secret-image')
    expect(text.length).toBeLessThan(600)
  })
})
