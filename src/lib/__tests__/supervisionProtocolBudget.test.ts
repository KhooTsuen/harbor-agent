import { afterEach, describe, expect, it, vi } from 'vitest'

type Plan = {
  kind: string
  problem: string
  scope: string[]
  steps: string[]
  expected: string
  verify: string
  criteria: string[]
}
type Review = {
  verdict: string
  reasons: string[]
  issues: string[]
  nextSteps: string[]
  answer: string
}
const { normalizePlan, normalizeReview, parseJsonBlock } =
  require('../../../electron/core/collab-protocol.cjs') as {
    normalizePlan: (value: unknown) => { ok: boolean; code?: string; plan?: Plan }
    normalizeReview: (value: unknown) => { ok: boolean; code?: string; review?: Review }
    parseJsonBlock: (value: string) => unknown
  }
type Event = { type: string; call?: string; usage?: { total_tokens: number } }
type Emit = ((event: Event) => void) & { requestId?: string }
type Budget = {
  signal: AbortSignal
  reason: () => string
  usage: () => { knownTokens: number; unknownCalls: number }
  record: (key: string, value: unknown, complete?: boolean) => unknown
  observe: (key: string, emit: Emit) => Emit
  dispose: () => void
}
const { createBudget } = require('../../../electron/core/collab-budget.cjs') as {
  createBudget: (
    input: { signal?: AbortSignal; closePending?: () => void },
    limits: { maxRuntime: number; maxTokens: number },
  ) => Budget
}
const budgets: Budget[] = []
afterEach(() => {
  budgets.splice(0).forEach((budget) => budget.dispose())
  vi.useRealTimers()
})
function budget(input: { signal?: AbortSignal; closePending?: () => void } = {}) {
  const instance = createBudget(input, { maxRuntime: 60, maxTokens: 0 })
  budgets.push(instance)
  return instance
}
const plan = {
  kind: 'research',
  problem: '查找近期景点资料',
  steps: ['实际检索并比较资料'],
  expected: '带来源的介绍',
  verify: '核对来源时效与覆盖范围',
  criteria: ['介绍回应原问题并附实际来源'],
}

describe('shared supervision plan and review protocol', () => {
  it('accepts a research plan without a project file scope', () => {
    expect(normalizePlan(plan)).toMatchObject({ ok: true, plan: { kind: 'research', scope: [] } })
  })

  it('requires a real scope for development even when every other plan field is present', () => {
    expect(normalizePlan({ ...plan, kind: 'development' })).toMatchObject({
      ok: false,
      code: 'PLAN_SCOPE_REQUIRED',
    })
    expect(normalizePlan({ ...plan, kind: 'development', scope: ['src/app.ts'] })).toMatchObject({
      ok: true,
      plan: { scope: ['src/app.ts'] },
    })
  })

  it('does not reinterpret an unknown typed plan as a valid development fallback', () => {
    expect(normalizePlan({ ...plan, kind: 'unrecognized', scope: ['src/app.ts'] })).toMatchObject({
      ok: false,
      code: 'PLAN_BAD_KIND',
    })
  })

  it('never accepts PASS without the actual user answer', () => {
    expect(normalizeReview({ verdict: 'PASS', reasons: ['检查通过'], answer: '  ' })).toMatchObject(
      { ok: false, code: 'REVIEW_NO_ANSWER' },
    )
    expect(
      normalizeReview({ verdict: 'PASS', reasons: ['已核对资料'], answer: '实际成果' }),
    ).toMatchObject({ ok: true, review: { answer: '实际成果' } })
  })

  it('requires actionable feedback instead of an unexplained needs-changes verdict', () => {
    expect(normalizeReview({ verdict: 'NEEDS_CHANGES', reasons: ['尚不完整'] })).toMatchObject({
      ok: false,
      code: 'REVIEW_NO_FEEDBACK',
    })
    const correction = normalizeReview({
      verdict: 'NEEDS_CHANGES',
      reasons: ['缺少时间信息'],
      issues: ['资料没有标注更新时间'],
      nextSteps: ['读取原始页面并补上实际更新时间'],
    })
    expect(correction).toMatchObject({
      ok: true,
      review: { nextSteps: ['读取原始页面并补上实际更新时间'] },
    })
  })

  it('promotes concrete legacy issues to next steps without losing their details', () => {
    expect(
      normalizeReview({
        verdict: 'NEEDS_CHANGES',
        reasons: ['缺少来源'],
        issues: ['检索官方页面并附上实际链接'],
      }),
    ).toMatchObject({ ok: true, review: { nextSteps: ['检索官方页面并附上实际链接'] } })
  })

  it('rejects malformed or oversized model objects rather than guessing a verdict', () => {
    expect(parseJsonBlock('```json\n{"verdict":"PASS"\n```')).toBeNull()
    expect(parseJsonBlock(JSON.stringify({ answer: 'x'.repeat(24_001) }))).toBeNull()
    expect(parseJsonBlock('说明\n```json\n{"verdict":"BLOCKED"}\n```')).toEqual({
      verdict: 'BLOCKED',
    })
  })
})

describe('supervision deadline and event boundaries', () => {
  it('shares the original deadline across activity and closes pending confirmation once', () => {
    vi.useFakeTimers()
    const closePending = vi.fn()
    const instance = budget({ closePending })
    vi.advanceTimersByTime(59_999)
    expect(instance.signal.aborted).toBe(false)
    instance.record('execute:2', { total_tokens: 10 }, true)
    vi.advanceTimersByTime(1)
    expect(instance.reason()).toBe('COLLAB_TIME_LIMIT')
    expect(instance.signal.aborted).toBe(true)
    expect(closePending).toHaveBeenCalledTimes(1)
  })

  it('preserves user cancellation as the first reason even when the deadline later passes', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const closePending = vi.fn()
    const instance = budget({ signal: controller.signal, closePending })
    controller.abort()
    vi.advanceTimersByTime(60_000)
    expect(instance.reason()).toBe('CANCELLED')
    expect(instance.signal.aborted).toBe(true)
    expect(closePending).toHaveBeenCalledTimes(1)
  })

  it('disposal removes deadline and parent cancellation effects', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const closePending = vi.fn()
    const instance = budget({ signal: controller.signal, closePending })
    instance.dispose()
    controller.abort()
    vi.advanceTimersByTime(60_000)
    expect(instance.signal.aborted).toBe(false)
    expect(closePending).not.toHaveBeenCalled()
  })

  it('preserves request identity while consuming internal usage events', () => {
    const events: Event[] = []
    const emit = Object.assign(
      (event: Event) => {
        events.push(event)
      },
      { requestId: 'original-request' },
    )
    const observed = budget().observe('execute:1', emit)
    observed({ type: 'collab.usage', call: 'call-1', usage: { total_tokens: 5 } })
    const content = { type: 'content' }
    observed(content)
    expect(observed.requestId).toBe('original-request')
    expect(events).toEqual([content])
  })

  it('retains one unknown model call after another call reports a known cumulative stage total', () => {
    const instance = budget()
    const observed = instance.observe('execute:1', () => {})
    observed({ type: 'collab.usage', call: 'first' })
    observed({ type: 'collab.usage', call: 'second', usage: { total_tokens: 7 } })
    observed({ type: 'turn_end', usage: { total_tokens: 7 } })
    instance.record('execute:1', { total_tokens: 7 }, true)
    expect(instance.usage()).toEqual({ knownTokens: 7, unknownCalls: 1 })
    expect(instance.signal.aborted).toBe(false)
  })
})
