import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分段快照必须保住工作痕迹（2026-10-20 真机 bug）

   现象：一轮被打断（崩溃 / 强杀 / 停止）之后重开会话，那条助手消息只剩
   一大段文字 —— 思考块和工具行**全部消失**，还挂着「这条回复没写完」。

   根因：`flushPartial` 只写 content / reasoning，`rounds` 与 `toolRuns`
   只在收尾那条（`persistReply`）里写。收尾没来 → 痕迹一个字都没落盘。

   这一组钉两件事：
     ① 快照带 rounds 与轻量工具记录（名字 / 摘要 / 成败 / 耗时）
     ② 快照**不带** output 正文（平均 1.3KB、最长 16KB，全量写会把快照撑爆）
   ══════════════════════════════════════════════════════════════ */

const persistMessage = vi.fn()

/** 假 store：里面有一条正在流式的占位消息（痕迹从这里读） */
const liveMessage: {
  id: string
  content: string
  reasoning: string
  rounds: MessageRound[]
  toolRuns: ToolRunRecord[]
  timestamp: number
} = {
  id: 'm1',
  content: '',
  reasoning: '',
  rounds: [],
  toolRuns: [],
  timestamp: 1,
}

vi.mock('@/stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      persistMessage,
      threads: [{ id: 'th1', messages: [liveMessage] }],
    }),
  },
}))

const { PARTIAL_MIN_MS } = await import('@/lib/partialFlush')
const { createReplyPersistence } = await import('../thread/replyPersistence')

const RUNS: ToolRunRecord[] = [
  {
    id: 't1',
    name: 'run_shell',
    summary: 'npm test',
    ok: true,
    output: 'x'.repeat(5000),
    ms: 1200,
  },
  { id: 't2', name: 'read_file', summary: 'README.md', ok: false, output: 'y'.repeat(3000) },
]

const ROUNDS: MessageRound[] = [
  { reasoning: '先看看项目结构', content: '', tools: [0] },
  { reasoning: '', content: '读完了', tools: [1] },
]

/**
 * 正文 + 思考要够长才会落盘 —— `shouldFlushPartial` 的两条规则（间隔 3 秒 /
 * 至少增长 30 字）。短回复本来就不需要中途快照，这里按真实长任务的量级造。
 */
const LONG_CONTENT = '读完了'.repeat(30)
const LONG_REASONING = '先看看项目结构'.repeat(20)

function makePersistence(): { flushPartial: () => void; persistReply: () => void } {
  return createReplyPersistence({
    threadId: 'th1',
    messageId: 'm1',
    timestamp: 1,
    getContent: () => LONG_CONTENT,
    getReasoning: () => LONG_REASONING,
    getEventType: () => 'done',
  })
}

describe('流式快照保住工作痕迹', () => {
  beforeEach(() => {
    persistMessage.mockClear()
    /* 每个用例从「刚开跑」开始：痕迹是空的，需要就自己填 */
    liveMessage.content = LONG_CONTENT
    liveMessage.reasoning = LONG_REASONING
    liveMessage.rounds = []
    liveMessage.toolRuns = []
    /*
     * 假时钟：`shouldFlushPartial` 要求「距上次至少 3 秒」，
     * 「节奏没到不写」那条用例需要推进时间才测得准。
     */
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T02:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ 快照带上时间线（rounds），中断后思考块还在', () => {
    liveMessage.rounds = ROUNDS
    makePersistence().flushPartial()

    expect(persistMessage).toHaveBeenCalledTimes(1)
    const record = persistMessage.mock.calls[0][1]
    expect(record.partial).toBe(true)
    expect(record.rounds).toEqual(ROUNDS)
  })

  it('★ 快照带上工具记录（名字 / 摘要 / 成败 / 耗时）', () => {
    liveMessage.toolRuns = RUNS
    makePersistence().flushPartial()

    const record = persistMessage.mock.calls[0][1]
    expect(record.toolRuns).toHaveLength(2)
    expect(record.toolRuns[0]).toMatchObject({
      id: 't1',
      name: 'run_shell',
      summary: 'npm test',
      ok: true,
      ms: 1200,
    })
    expect(record.toolRuns[1]).toMatchObject({ id: 't2', ok: false })
  })

  it('★ 快照不带 output 正文（否则每 3 秒重写几十 KB）', () => {
    liveMessage.toolRuns = RUNS
    makePersistence().flushPartial()

    const record = persistMessage.mock.calls[0][1]
    for (const run of record.toolRuns) expect(run.output).toBe('')
    /* 原始记录本身没被改（写的是副本） */
    expect(RUNS[0].output).toHaveLength(5000)
  })

  it('快照与 store 里的草稿不共享引用（改了草稿不会污染已写出的记录）', () => {
    liveMessage.rounds = ROUNDS
    makePersistence().flushPartial()

    const record = persistMessage.mock.calls[0][1]
    expect(record.rounds[0]).not.toBe(ROUNDS[0])
    expect(record.rounds[0].tools).not.toBe(ROUNDS[0].tools)
  })

  it('还没有痕迹时不硬塞空数组（老行为不变）', () => {
    makePersistence().flushPartial()

    const record = persistMessage.mock.calls[0][1]
    expect(record.rounds).toBeUndefined()
    expect(record.toolRuns).toBeUndefined()
  })

  it('节奏没到就一次都不写（不能每来一个字就刷盘）', () => {
    const persistence = makePersistence()
    persistence.flushPartial()
    expect(persistMessage).toHaveBeenCalledTimes(1)
    /* 立刻再调两次：不足 3 秒 → 一次都不该多写 */
    persistence.flushPartial()
    persistence.flushPartial()
    expect(persistMessage).toHaveBeenCalledTimes(1)
    /* 推过最小间隔后，内容没再长 → 仍然不写（续写才值得写） */
    vi.advanceTimersByTime(PARTIAL_MIN_MS + 100)
    persistence.flushPartial()
    expect(persistMessage).toHaveBeenCalledTimes(1)
  })

  it('收尾那条仍然写全量 output（快照省略了它，但最终记录不能少）', () => {
    liveMessage.rounds = ROUNDS
    liveMessage.toolRuns = RUNS
    makePersistence().persistReply()

    const record = persistMessage.mock.calls[0][1]
    expect(record.partial).toBeUndefined()
    expect(record.rounds).toEqual(ROUNDS)
    expect(record.toolRuns[0].output).toHaveLength(5000)
  })
})
