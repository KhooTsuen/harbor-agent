import { afterEach, describe, expect, it } from 'vitest'

type Run = {
  id: string
  name: string
  args: Record<string, unknown>
  output: string
  ok: boolean
  pending?: boolean
}
type Source = { toolId: string; name: string; url?: string; path?: string; snippet: string }
type Trace = {
  sources: Source[]
  tools: Run[]
  writes: string[]
  changedAfterTest: boolean
  lastTest: { status: string; ok: boolean } | null
}
type Review = {
  verdict: string
  answer: string
  reasons: string[]
  issues: string[]
  nextSteps: string[]
}
const { extractEvidence, constrainReview } =
  require('../../../electron/core/collab-evidence.cjs') as {
    extractEvidence: (runs: Run[] | null) => Trace
    constrainReview: (
      review: Review,
      trace: Trace,
      plan?: { kind: string },
      options?: { testsProhibited: boolean },
    ) => Review
  }
const { finalAnswer, renderRecord } = require('../../../electron/core/collab-output.cjs') as {
  finalAnswer: (state: Record<string, unknown>) => string
  renderRecord: (state: Record<string, unknown>, trace: Trace) => string
}
const { remember, forget } = require('../../../electron/core/redact.cjs') as {
  remember: (secret: string) => void
  forget: (secret: string) => void
}
const secret = 'supervision-acceptance-private-value'
afterEach(() => forget(secret))
const run = (name: string, output = '', args: Record<string, unknown> = {}): Run => ({
  id: `${name}-observed`,
  name,
  args,
  output,
  ok: true,
})
const pass = (answer = '用户要求的实际成果'): Review => ({
  verdict: 'PASS',
  answer,
  reasons: ['已核对本类任务的要求'],
  issues: [],
  nextSteps: [],
})
const searchResult =
  '搜索「景点」的结果：\n\n1. 景点资料\n   https://example.com/place\n   实际检索摘要\n'

describe('supervision task-specific acceptance', () => {
  it('writing and general answers do not depend on file changes or project tests', () => {
    const trace = extractEvidence([])
    for (const kind of ['writing', 'general'])
      expect(constrainReview(pass(), trace, { kind }).verdict).toBe('PASS')
  })

  it('research requires an observed lookup, not only a convincing model answer', () => {
    expect(
      constrainReview(pass('根据网页资料得出结论'), extractEvidence([]), { kind: 'research' })
        .verdict,
    ).toBe('NEEDS_CHANGES')
  })

  it('a URL echoed in an unsuccessful search query is not a real source', () => {
    const trace = extractEvidence([
      run('search_web', '搜索「https://example.com/place」没有结果。', {
        query: 'https://example.com/place',
      }),
    ])
    expect(trace.sources).toEqual([])
  })

  it('failed, pending, empty and accessible links cannot establish an actual lookup', () => {
    const trace = extractEvidence([
      { ...run('search_web', searchResult), ok: false },
      { ...run('search_web', searchResult), pending: true },
      run('browse', '', { url: 'https://example.com/place' }),
      run('browse_ax', 'link https://example.com/place'),
      run(
        'browse',
        '（Harbor 内置浏览器没有可读的正文）\nURL：https://example.com/place\n标题：资料',
      ),
    ])
    expect(trace.sources).toEqual([])
  })

  it('uses the browser returned final URL and does not claim linked pages were read', () => {
    const trace = extractEvidence([
      run(
        'browse',
        'URL：https://example.com/final\n标题：资料\n\n正文有链接 https://example.com/unread',
        { url: 'https://example.com/redirect' },
      ),
    ])
    expect(trace.sources.map((source) => source.url)).toEqual(['https://example.com/final'])
  })

  it('accepts actual search citations but rejects domain-prefix impersonation', () => {
    const trace = extractEvidence([run('search_web', searchResult)])
    const kind = { kind: 'research' }
    expect(
      constrainReview(pass('查看[资料](https://example.com/place#details)。'), trace, kind).verdict,
    ).toBe('PASS')
    expect(constrainReview(pass('https://example.com/place-forged'), trace, kind).verdict).toBe(
      'NEEDS_CHANGES',
    )
  })

  it('local research can cite actual file material without fabricating a web source', () => {
    const trace = extractEvidence([run('read_file', '调查笔记实际内容', { path: 'notes.md' })])
    expect(
      constrainReview(pass('根据 notes.md 的实际内容整理如下'), trace, { kind: 'research' })
        .verdict,
    ).toBe('PASS')
    expect(trace.sources[0]).toMatchObject({ path: 'notes.md' })
  })

  it('a passed test invalidated by later changes needs another permitted validation', () => {
    const trace = extractEvidence([
      run('run_project_test', '[退出码 0]'),
      run('edit_file', '已更新', { path: 'app.ts' }),
    ])
    expect(constrainReview(pass(), trace, { kind: 'development' }).verdict).toBe('NEEDS_CHANGES')
    const prohibited = constrainReview(
      pass(),
      trace,
      { kind: 'development' },
      { testsProhibited: true },
    )
    expect(prohibited.verdict).toBe('BLOCKED')
    expect(prohibited.issues.join(' ')).toContain('禁止运行测试')
  })

  it('missing or denied project verification never becomes a development PASS', () => {
    const development = { kind: 'development' }
    expect(constrainReview(pass(), extractEvidence([]), development).verdict).toBe('BLOCKED')
    const denied = extractEvidence([
      { ...run('run_project_test', '用户拒绝了这个操作'), ok: false },
    ])
    expect(constrainReview(pass(), denied, development).verdict).toBe('BLOCKED')
  })

  it('unknown tool completion prevents acceptance for every task category', () => {
    const trace = extractEvidence([
      { ...run('read_file', '', { path: 'notes.md' }), pending: true },
    ])
    for (const kind of ['research', 'writing', 'development', 'general'])
      expect(constrainReview(pass(), trace, { kind }).verdict).toBe('BLOCKED')
  })

  it('redacts secret material before evidence is handed to another model', () => {
    remember(secret)
    const trace = extractEvidence([
      run('read_file', `实际内容 ${secret}`, { path: 'notes.md', password: secret }),
    ])
    expect(JSON.stringify(trace)).not.toContain(secret)
    expect(trace.sources[0].snippet).toContain('已隐藏')
  })
})

describe('supervision user answer settlement', () => {
  const state = {
    status: 'blocked',
    phase: 'review',
    round: 1,
    roles: { planner: { label: '指导模型' }, executor: { label: '工作模型' } },
    error: { code: 'STOPPED', message: '缺少必要资料' },
    rounds: [{ round: 1, status: 'blocked', summary: '内部执行摘要，包含中间推演' }],
  }

  it('shows A actual answer on completion without a developer workflow template', () => {
    expect(
      finalAnswer({ ...state, status: 'completed', review: { answer: '景点清单及来源' } }),
    ).toBe('景点清单及来源')
  })

  it('keeps B internal summary in the record when A has no settled answer', () => {
    expect(finalAnswer(state)).not.toContain('内部执行摘要')
    expect(finalAnswer(state)).toContain('缺少必要资料')
    expect(renderRecord(state, extractEvidence([]))).toContain('内部执行摘要')
  })

  it('labels the previous supervisor answer when later work was interrupted before review', () => {
    const answer = finalAnswer({
      ...state,
      review: { answer: '第一轮阶段材料' },
      rounds: [
        { round: 1, status: 'blocked', review: { answer: '第一轮阶段材料' } },
        { round: 2, status: 'cancelled', summary: '第二轮尚未复核的内部结果' },
      ],
    })
    expect(answer).toContain('上一轮 A 整理的阶段成果；后续执行尚未复核')
    expect(answer).toContain('第一轮阶段材料')
    expect(answer).not.toContain('第二轮尚未复核的内部结果')
  })

  it('prioritizes the latest round supervisor answer over stale state review material', () => {
    const answer = finalAnswer({
      ...state,
      review: { answer: '旧阶段材料' },
      rounds: [{ round: 2, status: 'blocked', review: { answer: '最新阶段材料' } }],
    })
    expect(answer).toContain('最新阶段材料')
    expect(answer).not.toContain('旧阶段材料')
    expect(answer).not.toContain('上一轮 A 整理')
  })

  it('marks unfinished A material honestly and redacts direct output', () => {
    remember(secret)
    const answer = finalAnswer({ ...state, review: { answer: `阶段资料 ${secret}` } })
    expect(answer).toContain('尚未完成')
    expect(answer).toContain('阶段资料')
    expect(answer).not.toContain(secret)
  })
})
