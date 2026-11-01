import { describe, expect, it } from 'vitest'
import { handleStreamEvent, type StreamState } from '../thread/streamEvents'
import type { Message, MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   流式过程中的**分轮同步**

   锁住一个真实 bug（2026-09-30 用户：「任务进行中的流式对话排版太乱」）：

   `rounds` 以前只在 `done` 那个事件里挂到消息上，于是整场流式过程中
   渲染层都看不到分轮信息 → 退回老的三段堆叠（思考一大块 → 工具一张卡片 →
   正文），一直到最后才「啪」地跳成时间线。被中止的那条更惨：`aborted` 也不挂，
   落盘时 `final.rounds` 是 undefined → **存不进磁盘**（真机上 224 条消息
   一条带 rounds 的都没有，就是这个）。

   所以这里的判据是一句话：**事件一到，消息上就得有 rounds**。
   ══════════════════════════════════════════════════════════════ */

function harness(): { state: StreamState; patches: Partial<Message>[] } {
  const patches: Partial<Message>[] = []
  const state: StreamState = {
    content: '',
    reasoning: '',
    toolRuns: [] as ToolRunRecord[],
    rounds: [] as MessageRound[],
    citations: [],
    /* 只记「写回了什么」，不碰真的 store —— 这条链路要测的就是写回了什么 */
    patch: (fields) => patches.push(fields),
    snapshot: () => ({}) as Message,
    finish: () => {},
    threadId: 't1',
    /* 重试回滚起点（本组测 rounds 同步，不走 retry） */
    retryMarks: { text: 0, think: 0, round: -1, roundText: 0, roundThink: 0 },
  }
  return { state, patches }
}

/** 最后一次写回 */
const last = (patches: Partial<Message>[]): Partial<Message> => patches[patches.length - 1]

describe('流式分轮（rounds 要随事件同步到消息上）', () => {
  it('★ turn_start 一到就挂上（新一轮不能等出了字才出现）', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'turn_start' }, state)
    expect(last(patches).rounds).toHaveLength(1)
  })

  it('★ 思考与正文一路长出来，rounds 一路跟着（不是等 done）', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'turn_start' }, state)
    handleStreamEvent({ type: 'reasoning', text: '先看一眼' }, state)
    handleStreamEvent({ type: 'content', text: '正文' }, state)

    const round = last(patches).rounds?.[0]
    expect(round?.reasoning).toBe('先看一眼')
    expect(round?.content).toBe('正文')
    /* 关键：此刻还没有 done */
    expect(patches.some((patch) => patch.rounds !== undefined)).toBe(true)
  })

  it('★ 两轮分得开（第二轮有自己的正文，不拼成一大段）', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'reasoning', text: 'r1' }, state)
    handleStreamEvent({ type: 'content', text: 'c1' }, state)
    handleStreamEvent({ type: 'turn_start' }, state)
    handleStreamEvent({ type: 'reasoning', text: 'r2' }, state)
    handleStreamEvent({ type: 'content', text: 'c2' }, state)

    expect(last(patches).rounds?.map((round) => round.content)).toEqual(['c1', 'c2'])
  })

  it('工具开始时就记下标（这一轮跑过哪几个）', () => {
    const { state, patches } = harness()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'a', name: 'read_file', args: { path: 'x.md' } },
      state,
    )
    expect(last(patches).rounds?.[0].tools).toEqual([0])
  })

  it('★ 被中止也带上 rounds（不然落盘只存内容、丢掉时间线）', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'content', text: '半截话' }, state)
    handleStreamEvent({ type: 'aborted' }, state)

    const patch = last(patches)
    expect(patch.interrupted).toBe(true)
    expect(patch.rounds).toHaveLength(1)
    expect(patch.rounds?.[0].content).toBe('半截话')
  })

  it('最终汇报与流式过程不同，最终汇报必须进入实际渲染的 rounds', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'content', text: '规划与执行过程' }, state)
    handleStreamEvent({ type: 'done', content: '最终协作汇报' }, state)
    expect(last(patches).content).toBe('最终协作汇报')
    expect(last(patches).rounds?.map((round) => round.content)).toEqual([
      '规划与执行过程',
      '最终协作汇报',
    ])
  })

  it('最终正文已经在最后一轮时，不重复追加', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'content', text: '过程' }, state)
    handleStreamEvent({ type: 'turn_start' }, state)
    handleStreamEvent({ type: 'content', text: '最终正文' }, state)
    handleStreamEvent({ type: 'done', content: '最终正文' }, state)
    expect(last(patches).rounds).toHaveLength(2)
  })

  it('普通单轮流式收尾保持一轮，不重复正文', () => {
    const { state, patches } = harness()
    handleStreamEvent({ type: 'content', text: '普通回答' }, state)
    handleStreamEvent({ type: 'done', content: '普通回答' }, state)
    expect(last(patches).rounds).toHaveLength(1)
  })
})
