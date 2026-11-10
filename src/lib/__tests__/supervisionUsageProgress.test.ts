import { afterEach, describe, expect, it } from 'vitest'

type Event = { type: string; call?: number; usage?: Record<string, number> }
type Budget = {
  reason: () => string
  usage: () => { knownTokens: number; unknownCalls: number }
  report: () => Record<string, number>
  observe: (key: string, emit: (event: Event) => void) => (event: Event) => void
  record: (key: string, usage: unknown, complete?: boolean) => void
  dispose: () => void
}
const { createBudget } = require('../../../electron/core/collab-budget.cjs') as {
  createBudget: (input: object, limits: { maxRuntime: number; maxTokens: number }) => Budget
}
const { progressKey } = require('../../../electron/core/collab-progress.cjs') as {
  progressKey: (
    summary: string,
    review: unknown,
    trace: {
      kind: string
      writes: string[]
      tools: Array<{ name: string; ok: boolean; args: object; output: string }>
    },
  ) => string
}
const budgets: Budget[] = []
afterEach(() => budgets.splice(0).forEach((budget) => budget.dispose()))
function budget(maxTokens = 0) {
  const value = createBudget({}, { maxRuntime: 60, maxTokens })
  budgets.push(value)
  return value
}

describe('aggregate usage across calls and stages', () => {
  it('counts each call once despite duplicate reports and cumulative final totals', () => {
    const instance = budget()
    const emit = instance.observe('execute:1', () => {})
    emit({
      type: 'collab.usage',
      call: 1,
      usage: { total_tokens: 100, prompt_tokens: 70, completion_tokens: 30 },
    })
    emit({
      type: 'collab.usage',
      call: 1,
      usage: { total_tokens: 50, prompt_tokens: 30, completion_tokens: 20 },
    })
    emit({
      type: 'collab.usage',
      call: 2,
      usage: { total_tokens: 120, prompt_tokens: 80, completion_tokens: 40 },
    })
    emit({
      type: 'turn_end',
      usage: { total_tokens: 220, prompt_tokens: 150, completion_tokens: 70 },
    })
    instance.record(
      'execute:1',
      { total_tokens: 220, prompt_tokens: 150, completion_tokens: 70 },
      true,
    )
    instance.record('review:1', { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 }, true)
    expect(instance.report()).toEqual({
      total_tokens: 230,
      prompt_tokens: 156,
      completion_tokens: 74,
    })
    expect(instance.usage()).toEqual({ knownTokens: 230, unknownCalls: 0 })
  })

  it('applies the shared token limit as soon as a later call returns usage', () => {
    const instance = budget(150)
    const emit = instance.observe('execute:1', () => {})
    emit({ type: 'collab.usage', call: 1, usage: { total_tokens: 100 } })
    expect(instance.reason()).toBe('')
    emit({ type: 'collab.usage', call: 2, usage: { total_tokens: 60 } })
    expect(instance.reason()).toBe('COLLAB_TOKEN_LIMIT')
  })

  it('does not turn a duplicate empty usage event into an unknown paid call', () => {
    const instance = budget(1000)
    const emit = instance.observe('review:1', () => {})
    emit({ type: 'collab.usage', call: 1, usage: { total_tokens: 10 } })
    emit({ type: 'collab.usage', call: 1 })
    expect(instance.usage()).toEqual({ knownTokens: 10, unknownCalls: 0 })
    emit({ type: 'collab.usage', call: 2 })
    expect(instance.reason()).toBe('COLLAB_USAGE_UNKNOWN')
  })
})

describe('research repetition detection', () => {
  const tool = {
    name: 'browse',
    args: { url: 'https://example.org/' },
    ok: true,
    output: '页面的实际信息',
  }
  const trace = { kind: 'research', writes: [], tools: [tool] }
  it('ignores changed reviewer wording, reordered evidence and repeated recall', () => {
    const key = progressKey('B 摘要', { issues: ['补更多'] }, trace)
    expect(
      progressKey(
        'B 改写摘要',
        { issues: ['再完善'] },
        {
          ...trace,
          tools: [tool, { ...tool, name: 'recall', output: '回取内容' }, tool],
        },
      ),
    ).toBe(key)
  })
  it('recognizes a real change in tool output', () => {
    expect(progressKey('', {}, trace)).not.toBe(
      progressKey(
        '',
        {},
        {
          ...trace,
          tools: [{ ...tool, output: '读取到了新的实际信息' }],
        },
      ),
    )
  })
})
