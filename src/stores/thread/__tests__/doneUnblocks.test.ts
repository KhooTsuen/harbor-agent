import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   清退链不许把收尾带走（2026-10-04 真机事故）

   现象（用户报的）：系统通知已经弹出「任务完成」、任务台账 6/6、界面却一直停在
   「运行中」—— 输入区一直是暂停/停止，而且**那一轮的回复没落盘**（会话文件 mtime
   停在几分钟前）。磁盘上连一行错误都没有。

   根因形状：收尾（`state.finish()`）排在 `state.patch({...})` **后面**，patch 抛一次
   异常，收尾就永远轮不到；异常又被订阅回调吞掉，事后查不到。
   同一个形状在 `turns.ts` 的 `finish()` 里也有（它第一句就是落盘）。

   这一组钉三件事：
     ① 收尾**先做**，而且 patch / finish 各自抛异常都不许把后面的带走；
     ② 抛了要**留痕**（渲染层 → 主进程 → data/errors/*.jsonl），别再做无声异常；
     ③ 顺序这件事本身用源码断言钉住（接线测试照不到层与层之间，见 streamEvents 文件头）。
   ══════════════════════════════════════════════════════════════ */

/* 留痕通道换成间谍：断言「记了一笔」，但不真的往磁盘写 */
vi.mock('@/lib/actionLog', () => ({ logError: vi.fn() }))
/* 收尾钩子会去动任务台账，这里不需要它 */
vi.mock('../confirmEvents', () => ({
  askPermissionFor: vi.fn(),
  applyPauseAfterTurn: vi.fn(),
  onClarifyTimeout: vi.fn(),
}))

const { handleStreamEvent } = await import('../streamEvents')
const { logError } = await import('@/lib/actionLog')

const ROOT = join(__dirname, '..', '..', '..', '..')
const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')
const turnsSrc = readFileSync(join(ROOT, 'src/stores/thread/turns.ts'), 'utf8')

type Hooks = { patch?: () => void; finish?: () => void }

/** 造一个最小可用的 StreamState，并且记录调用顺序 */
function makeState(hooks: Hooks = {}) {
  const calls: string[] = []
  const patches: Array<Record<string, unknown>> = []
  const state = {
    content: '流式累积的正文',
    reasoning: '',
    toolRuns: [],
    rounds: [{ reasoning: '', content: '', tools: [] }],
    citations: [],
    threadId: 't1',
    patch: (fields: Record<string, unknown>) => {
      calls.push('patch')
      patches.push(fields)
      hooks.patch?.()
    },
    snapshot: () => ({ id: 'm1' }),
    finish: () => {
      calls.push('finish')
      hooks.finish?.()
    },
  }
  return { state: state as never, calls, patches }
}

describe('收尾不许被写字段带走', () => {
  it('★ patch 抛异常时，收尾照样执行（事故的正面回归）', () => {
    const { state, calls } = makeState({
      patch: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')")
      },
    })
    const result = handleStreamEvent({ type: 'done', content: '最终正文' }, state)
    expect(calls).toContain('finish')
    expect(calls.indexOf('finish')).toBeLessThan(calls.indexOf('patch'))
    expect(result).toEqual({ handled: true, notifyDone: true })
  })

  it('★ 抛出来的那一笔要留痕（别再做无声异常）', () => {
    const { state } = makeState({
      patch: () => {
        throw new Error('写字段炸了')
      },
    })
    handleStreamEvent({ type: 'done' }, state)
    expect(logError).toHaveBeenCalledWith('stream.done.patch', expect.any(Error))
  })

  it('★ 收尾自己抛也不许冒泡（后面的后置任务还要跑）', () => {
    const { state, calls } = makeState({
      finish: () => {
        throw new Error('收尾炸了')
      },
    })
    const result = handleStreamEvent({ type: 'done' }, state)
    expect(calls).toContain('patch')
    expect(logError).toHaveBeenCalledWith('stream.done.finish', expect.any(Error))
    expect(result).toEqual({ handled: true, notifyDone: true })
  })

  it('正常路径：收尾一次、字段写全（content / status）', () => {
    const { state, calls, patches } = makeState()
    handleStreamEvent({ type: 'done', content: '最终正文' }, state)
    expect(calls.filter((c) => c === 'finish')).toHaveLength(1)
    expect(patches[0]).toMatchObject({ content: '最终正文', status: 'sent', kind: 'text' })
  })

  it('aborted / error 同样是「先收尾」', () => {
    for (const type of ['aborted', 'error']) {
      const { state, calls } = makeState({
        patch: () => {
          throw new Error(`${type} 写字段炸了`)
        },
      })
      handleStreamEvent({ type }, state)
      expect(calls, type).toContain('finish')
      expect(calls.indexOf('finish'), type).toBeLessThan(calls.indexOf('patch'))
    }
  })
})

describe('接线：顺序本身也要钉住（层与层之间测试照不到）', () => {
  it('★ `case done` 段里，收尾排在写字段之前', () => {
    const block = streamSrc.slice(
      streamSrc.indexOf("case 'done':"),
      streamSrc.indexOf("case 'aborted':"),
    )
    expect(block).toContain("runSafely('done.finish'")
    expect(block).toContain("runSafely('done.patch'")
    expect(block.indexOf('done.finish')).toBeLessThan(block.indexOf('done.patch'))
  })

  it('★ turns.ts 的 finish()：先摘「正在跑」再落盘', () => {
    const start = turnsSrc.indexOf('const finish = (): void => {')
    const block = turnsSrc.slice(start, start + 1400)
    expect(block.indexOf('sendingThreads: s.sendingThreads.filter')).toBeLessThan(
      block.indexOf('persistence.persistReply()'),
    )
    expect(block).toContain("logError('turn.persistReply'")
  })

  /*
   * ★ 兜底（5 分钟超时）也走同一条路 —— 2026-10-04 当晚它就是第二个卡住的地方：
   *   回调里第一句是 patch，抛了以后 finish() 也不会跑，于是「兜底」跟着一起失效。
   */
  it('★ 超时兜底：先收尾再写状态，写状态失败也有留痕', () => {
    const start = turnsSrc.indexOf('const onTurnTimeout = (): void => {')
    expect(start, '找不到兜底回调（改名了？）').toBeGreaterThan(0)
    const block = turnsSrc.slice(start, start + 600)
    expect(block.indexOf('finish()')).toBeLessThan(block.indexOf('patch({'))
    expect(block).toContain("logError('turn.timeout'")
    expect(block).toContain('try {')
  })

  it('★ 超时时长是具名常量（改时长这件事要看得见）', () => {
    expect(turnsSrc).toContain('export const TURN_TIMEOUT_MS')
    expect(turnsSrc).toContain('window.setTimeout(onTurnTimeout, TURN_TIMEOUT_MS)')
  })
})
