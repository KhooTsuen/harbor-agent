import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Boundary cases are added as source only; this delivery does not run tests.
type Run = { id: string; name: string; ok: boolean; output: string; pending?: boolean }
type Reply = { ok: boolean; text: string }
const { readLive } = require('../../../electron/core/recall-live.cjs') as {
  readLive: (
    args: Record<string, unknown>,
    ctx: {
      recallEvidence?: () => { executionId: string; runs: Run[] } | null
    },
  ) => Reply | null
}
const recall = require('../../../electron/core/session-recall.cjs') as {
  collect: (id: string) => Promise<{ total: number; calls: Array<{ chars: number }> }>
  catalogOf: (id: string) => Promise<{ text: string }>
  fragmentOf: (id: string, options: Record<string, unknown>) => Promise<Reply>
}
const sessionIo = require('../../../electron/core/session-io.cjs') as {
  fileFor: (id: string) => string
}
type Ref = { toolId: string; claim: string; quote: string; purpose?: string }
const { reviewEvidence } = require('../../../electron/core/collab-review-evidence.cjs') as {
  reviewEvidence: (
    review: { evidence: Ref[] },
    trace: { tools: Run[] },
    required?: boolean,
  ) => string
}
const { constrainReview } = require('../../../electron/core/collab-evidence.cjs') as {
  constrainReview: (
    review: Record<string, unknown>,
    trace: { tools: Run[] },
    plan: { kind: string },
    options: { requireEvidence: boolean },
  ) => { verdict: string; answer: string }
}
const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})
const run = (
  id = 'exec:execute:1:0:call',
  output = '读取到的真实资料正文，带有完整上下文。',
): Run => ({ id, name: 'run_shell', ok: true, output })
function fixture(rows: Array<Record<string, unknown>>) {
  const folder = mkdtempSync(join(tmpdir(), 'harbor-recall-fixture-'))
  folders.push(folder)
  const file = join(folder, 'session.jsonl')
  writeFileSync(
    file,
    rows
      .map((row) =>
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          key: 'reply',
          execId: 'exec',
          ...row,
        }),
      )
      .join('\n'),
  )
  vi.spyOn(sessionIo, 'fileFor').mockReturnValue(file)
}

describe('live evidence and snapshot identity', () => {
  it('retrieves material beyond the handoff excerpt and keeps execution scope', () => {
    const tool = run(undefined, 'x'.repeat(4500) + '景点实际人数为四百万人，统计日期明确。')
    const ctx = { recallEvidence: () => ({ executionId: 'exec', runs: [tool] }) }
    expect(readLive({ callId: tool.id, offset: 4500 }, ctx)?.text).toContain('景点实际人数')
    expect(readLive({ callId: 'foreign-exec:call' }, ctx)?.ok).toBe(false)
    expect(readLive({}, { recallEvidence: () => null })?.ok).toBe(false)
    expect(readLive({ n: -1 }, ctx)?.ok).toBe(false)
    expect(readLive({ offset: Infinity }, ctx)?.ok).toBe(false)
  })

  it('does not turn a pending or expired result into an available full body', () => {
    const tool = { ...run(), pending: true }
    expect(
      readLive(
        { callId: tool.id },
        {
          recallEvidence: () => ({ executionId: 'exec', runs: [tool] }),
        },
      )?.text,
    ).toContain('尚未结束')
    expect(readLive({}, {})).toBeNull()
  })

  it('counts repeated cumulative snapshots once and preserves the complete output', async () => {
    const tool = run()
    fixture([
      { partial: true, toolRuns: [{ ...tool, output: '' }] },
      { toolRuns: [tool] },
      { partial: true, toolRuns: [{ ...tool, output: '' }] },
    ])
    expect(await recall.collect('session')).toMatchObject({
      total: 1,
      calls: [{ chars: tool.output.length }],
    })
    expect((await recall.fragmentOf('session', { callId: tool.id })).text).toContain(tool.output)
  })

  it('labels missing snapshot bodies and rejects ambiguous fingerprints', async () => {
    fixture([{ partial: true, toolRuns: [{ ...run(), output: '' }] }])
    expect((await recall.catalogOf('session')).text).toContain('仅有快照元数据')
    expect((await recall.fragmentOf('session', { callId: run().id })).ok).toBe(false)
    fixture([{ toolRuns: [run('one'), run('two')] }])
    const { fingerprint } = require('../../../electron/core/history-fold.cjs') as {
      fingerprint: (s: string) => string
    }
    const { viewContentOf } = require('../../../electron/core/session-recall.cjs') as {
      viewContentOf: (r: Run) => string
    }
    expect((await recall.fragmentOf('session', { fp: fingerprint(viewContentOf(run())) })).ok).toBe(
      false,
    )
    expect((await recall.fragmentOf('session', { callId: 'two' })).ok).toBe(true)
  })
})

describe('review provenance', () => {
  const ref = (tool: Run, purpose = 'fact', quote = tool.output): Ref => ({
    toolId: tool.id,
    claim: '根据实际记录判断',
    quote,
    purpose,
  })

  it('rejects query echoes but permits substantive command output as evidence', () => {
    const echo = run('echo', '=== 搜索某热门景点实际人数\n[退出码 0]')
    const fetched = run()
    expect(reviewEvidence({ evidence: [ref(echo)] }, { tools: [echo] }, true)).not.toBe('')
    expect(reviewEvidence({ evidence: [ref(fetched)] }, { tools: [fetched] }, true)).toBe('')
  })

  it('accepts a failed access observation without treating it as webpage facts', () => {
    const failed = {
      ...run('403', 'URL：https://example.org/\n标题：403 Forbidden\n403 Forbidden'),
      name: 'browse',
    }
    expect(reviewEvidence({ evidence: [ref(failed, 'execution')] }, { tools: [failed] })).toBe('')
    expect(reviewEvidence({ evidence: [ref(failed)] }, { tools: [failed] })).not.toBe('')
    const empty = run('empty', '')
    expect(reviewEvidence({ evidence: [ref(empty, 'execution', '')] }, { tools: [empty] })).toBe('')
  })

  it('stops ungrounded feedback and withholds its unsupported user answer', () => {
    const tool = run()
    const result = constrainReview(
      {
        verdict: 'NEEDS_CHANGES',
        reasons: ['没有读取'],
        issues: ['再读一次'],
        nextSteps: ['再读一次'],
        answer: '未经支持的结论',
        evidence: [ref({ ...tool, id: 'wrong-execution' })],
      },
      { tools: [tool] },
      { kind: 'research' },
      { requireEvidence: true },
    )
    expect(result).toMatchObject({ verdict: 'BLOCKED', answer: '' })
  })
})
