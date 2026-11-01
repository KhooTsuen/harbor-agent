import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   重试不许让同一段话显示两遍（2026-10-21 用户真机报的）

   现象（用户原话）：「你刚刚的回答就有重复回答，看截图」。截图里同一轮里先是
   一份断在句子中间的正文，接着从头把整段再说一遍。

   根因：上游报可重试的错（限流 / 超时 / 服务器错）时 `loop-model.cjs:148-152`
   会**从头重新请求整段**，而渲染层只把新分片往后追加。这条约定主进程给扩展侧边栏
   那份快照（`ext-chat-streams.cjs:132-139`）**早就实现了**，只有主链路漏了 ——
   同一约定两套写法，正是 AGENT.md 第 9 条要消灭的东西。

   这一组钉四件事：
     ① 「半截 + 整段重说」之后只剩一份；
     ② 重试只退**本轮**，前面几轮一个字不动（一轮循环里模型会被调多次）；
     ③ 没有半截可退时不写字段（不制造无谓重渲）；
     ④ 「正在重试」这句提示**保留**（用户拍板）—— 回滚不替代告知。
   ══════════════════════════════════════════════════════════════ */

/* 提示通道换成间谍：断言「说了这一句」，不真的弹 toast */
vi.mock('../noticeEvents', () => ({ handleNoticeEvent: vi.fn() }))
/* 这几条链路与本组无关，但在 streamEvents / streamLight 的 import 图里 */
vi.mock('@/lib/actionLog', () => ({ logError: vi.fn() }))
vi.mock('../confirmEvents', () => ({
  askPermissionFor: vi.fn(),
  applyPauseAfterTurn: vi.fn(),
  onClarifyTimeout: vi.fn(),
}))
vi.mock('../toolRefresh', () => ({ refreshAfterTool: vi.fn() }))
vi.mock('@/stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({ patch: vi.fn(), setThreadPhase: vi.fn(), updateMessage: vi.fn() }),
  },
}))
vi.mock('@/stores/usePerfStore', () => ({
  usePerfStore: { getState: () => ({ markFirstContent: vi.fn() }) },
}))

const { handleStreamEvent } = await import('../streamEvents')
const { markRoundStart } = await import('../retryRollback')
const { handleNoticeEvent } = await import('../noticeEvents')

type St = Parameters<typeof handleStreamEvent>[1]

/** 造一个能记录 patch 的流式状态（形状与 turns.ts 给的一致） */
function makeState(rounds: Array<{ content: string; reasoning: string }>) {
  const patches: Array<Record<string, unknown>> = []
  const state = {
    content: rounds.map((r) => r.content).join(''),
    reasoning: rounds.map((r) => r.reasoning).join(''),
    toolRuns: [],
    rounds: rounds.map((r) => ({ reasoning: r.reasoning, content: r.content, tools: [] })),
    citations: [],
    threadId: 't1',
    retryMarks: { text: 0, think: 0, round: -1, roundText: 0, roundThink: 0 },
    patch: (fields: Record<string, unknown>) => {
      patches.push(fields)
    },
    snapshot: () => ({ id: 'm1' }),
    finish: () => {},
  } as unknown as St
  state.retryMarks = markRoundStart(state.content, state.reasoning, state.rounds)
  return { state, patches }
}

beforeEach(() => {
  vi.mocked(handleNoticeEvent).mockClear()
})

describe('重试回滚：屏幕上只剩一份', () => {
  it('★ 「半截 + 整段重说」→ 退成一份（用户截图那个形状）', () => {
    const { state, patches } = makeState([{ content: '', reasoning: '' }])
    /* 第一段：流到句子中间 */
    handleStreamEvent({ type: 'content', text: '谢谢，先别急着夸' }, state)
    expect(state.content).toBe('谢谢，先别急着夸')

    /* 上游重试（限流 / 超时）→ 退回去 */
    handleStreamEvent({ type: 'retry', hint: '请求超时' }, state)
    expect(state.content).toBe('')
    expect(patches.at(-1)?.content).toBe('')

    /* 整段重说 —— 屏幕上只有这份 */
    handleStreamEvent({ type: 'content', text: '谢谢，先别急着夸——按规矩来' }, state)
    expect(state.content).toBe('谢谢，先别急着夸——按规矩来')
    expect(state.rounds[0].content).toBe('谢谢，先别急着夸——按规矩来')
  })

  it('★ 只退本轮：前面几轮说过的话一个字不动', () => {
    const { state } = makeState([
      { content: '第一轮的结论', reasoning: '第一轮的思考' },
      { content: '', reasoning: '' },
    ])
    handleStreamEvent({ type: 'content', text: '第二轮的半截' }, state)
    handleStreamEvent({ type: 'retry', hint: '服务器出错' }, state)

    expect(state.rounds[0].content).toBe('第一轮的结论')
    expect(state.rounds[0].reasoning).toBe('第一轮的思考')
    expect(state.rounds[1].content).toBe('')
    /* 全局正文也只退到本轮起点 */
    expect(state.content).toBe('第一轮的结论')
    expect(state.reasoning).toBe('第一轮的思考')
  })

  it('思考也各退各的（正文与思考累积量不同，不能共用一个数）', () => {
    const { state } = makeState([{ content: '', reasoning: '' }])
    handleStreamEvent({ type: 'reasoning', text: '想一想' }, state)
    handleStreamEvent({ type: 'content', text: '说一句' }, state)
    handleStreamEvent({ type: 'retry' }, state)
    expect(state.reasoning).toBe('')
    expect(state.content).toBe('')
  })

  it('没有半截可退 → 不写字段（不制造无谓重渲）', () => {
    const { state, patches } = makeState([{ content: '上一轮', reasoning: '' }])
    const before = patches.length
    handleStreamEvent({ type: 'retry', hint: '超时' }, state)
    expect(patches.length).toBe(before)
  })

  it('★ 「正在重试」这句提示保留（回滚不替代告知）', () => {
    const { state } = makeState([{ content: '', reasoning: '' }])
    handleStreamEvent({ type: 'content', text: '半截' }, state)
    handleStreamEvent({ type: 'retry', hint: '请求超时' }, state)
    expect(handleNoticeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'retry', hint: '请求超时' }),
    )
  })

  it('turn_start 之后的重试退到新一轮起点（不连上一轮一起退）', () => {
    const { state } = makeState([{ content: '上一轮结论', reasoning: '' }])
    handleStreamEvent({ type: 'turn_start' }, state)
    handleStreamEvent({ type: 'content', text: '这一轮半截' }, state)
    handleStreamEvent({ type: 'retry' }, state)
    expect(state.content).toBe('上一轮结论')
    expect(state.rounds[0].content).toBe('上一轮结论')
    expect(state.rounds[1].content).toBe('')
  })
})
