import { describe, expect, it } from 'vitest'
import { harness, review, type Emit } from './supervisionControlHarness'

describe('supervisor correction and stopping boundaries', () => {
  it('automatically returns concrete feedback to B and delivers only A’s accepted answer', async () => {
    const correction = review('NEEDS_CHANGES', '第一版不完整')
    const h = harness({ reviews: [correction, review('PASS', '两项比较与结论')] })
    const result = await h.run()
    expect(result.accepted).toBe(true)
    expect(result.finalContent).toBe('两项比较与结论')
    expect(h.contexts[1]).toMatchObject({
      round: 2,
      previousResult: '第 1 轮成果',
      feedback: correction,
    })
    expect(h.counts().confirmations).toBe(0)
  })

  it('never retries a BLOCKED review', async () => {
    const h = harness({ reviews: [review('BLOCKED')] })
    expect(await h.run()).toMatchObject({ accepted: false, code: 'REVIEW_BLOCKED' })
    expect(h.contexts).toHaveLength(1)
  })

  it('stops at the configured round budget and preserves the latest result', async () => {
    const h = harness({ maxRounds: 2, reviews: [review('NEEDS_CHANGES'), review('NEEDS_CHANGES')] })
    expect(await h.run()).toMatchObject({
      accepted: false,
      code: 'COLLAB_ROUND_LIMIT',
      collaboration: { status: 'paused' },
    })
    expect(h.contexts).toHaveLength(2)
  })

  it('cancellation after a B result preserves that round and never invokes another model', async () => {
    const h = harness({
      execute: () => {
        h.controller.abort()
        return { finalContent: '已取得的部分成果' }
      },
    })
    const result = await h.run()
    expect(result).toMatchObject({ accepted: false, code: 'CANCELLED' })
    expect(result.collaboration.rounds[0].summary).toBe('已取得的部分成果')
    expect(h.counts()).toMatchObject({ reviews: 0, closed: 1 })
  })

  it('a denied operation stops immediately and cannot be reapproved or accepted by A', async () => {
    const h = harness({
      approve: false,
      execute: async (input) => {
        expect(await input.confirm({ name: 'write_file' })).toBe(false)
        expect(await input.confirm({ name: 'write_file' })).toBe(false)
        return { finalContent: '未获批准' }
      },
    })
    expect(await h.run()).toMatchObject({ accepted: false, code: 'TOOL_DENIED' })
    expect(h.counts()).toMatchObject({ confirmations: 1, reviews: 0 })
  })

  it('a rejected execution gate cannot be cleared by an internal review or next round', async () => {
    const h = harness({
      execute: () => {
        h.denyGate()
        return { finalContent: '用户要求停手' }
      },
    })
    expect(await h.run()).toMatchObject({ accepted: false, code: 'TOOL_DENIED' })
    expect(h.counts().reviews).toBe(0)
    expect(h.contexts).toHaveLength(1)
  })

  it('rounds can reuse a child tool ID and late events cannot overwrite later evidence', async () => {
    let oldEmit: Emit | undefined
    const h = harness({
      reviews: [review('NEEDS_CHANGES'), review('PASS', '最终结果')],
      execute: (_input, emit, context) => {
        oldEmit?.({
          type: 'agent.tool.failed',
          toolCallId: 'same',
          name: 'read_file',
          result: 'late',
        })
        emit({
          type: 'agent.tool.started',
          toolCallId: 'same',
          name: 'read_file',
          args: { path: 'a' },
        })
        emit({
          type: 'agent.tool.completed',
          toolCallId: 'same',
          name: 'read_file',
          ok: true,
          result: `round ${context.round}`,
        })
        oldEmit = emit
        return { finalContent: `result ${context.round}` }
      },
    })
    const result = await h.run()
    expect(new Set(result.toolRuns.map((run) => run.id)).size).toBe(2)
    expect(result.toolRuns.map((run) => run.output)).toEqual(['round 1', 'round 2'])
    expect(h.events.filter((event) => event.type === 'agent.tool.failed')).toHaveLength(0)
  })

  it('cumulative stage usage is counted once across stream updates and the final result', async () => {
    const h = harness({
      execute: (_input, emit) => {
        emit({ type: 'turn_end', usage: { total_tokens: 5 } })
        emit({ type: 'turn_end', usage: { total_tokens: 10 } })
        return { finalContent: '成果', usage: { total_tokens: 10 } }
      },
    })
    expect((await h.run()).collaboration.usage).toEqual({ knownTokens: 30, unknownCalls: 0 })
  })

  it('an unknown B usage stops a configured token budget without pretending it is free', async () => {
    const h = harness({ maxTokens: 100, execute: () => ({ finalContent: '成果' }) })
    expect(await h.run()).toMatchObject({
      accepted: false,
      code: 'COLLAB_USAGE_UNKNOWN',
      collaboration: { usage: { knownTokens: 10, unknownCalls: 1 } },
    })
    expect(h.counts().reviews).toBe(0)
  })
})
