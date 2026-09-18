import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstLine } from '../ProgressTimeline'

/* ══════════════════════════════════════════════════════════════
   AG-005：进度时间线

   分三块测：
     · `firstLine` —— 时间线一行只放一句，多行输出要能取干净
     · 相位历史 —— 「走过的路」是**事件驱动**记的，但相邻必须去重
       （`executing` 一轮里每个工具转移一次，不去重历史全是同一个词）
     · **源码守卫** —— 时间线的数据从哪来、以及三件「不做的事」有没有被改回去
   ══════════════════════════════════════════════════════════════ */

/* store 那条链会拉进 @/lib/backend，别让它去碰真的 IPC */
vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false }
})

const { useAppStore } = await import('@/stores/useAppStore')

const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('ProgressTimeline / firstLine', () => {
  it('多行取第一行', () => {
    expect(firstLine('package.json: 42 行\n后面还有很多')).toBe('package.json: 42 行')
  })

  it('跳过开头的空行（工具输出经常先来几个空行）', () => {
    expect(firstLine('\n\n  真实内容  \n别的')).toBe('真实内容')
  })

  it('把行内空白压成一个空格', () => {
    expect(firstLine('a    b\t\tc')).toBe('a b c')
  })

  it('太长就截断并加省略号', () => {
    const out = firstLine('x'.repeat(200))
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(73)
  })

  it('空串 / 纯空白给空串（调用方据此不渲染那半截）', () => {
    expect(firstLine('')).toBe('')
    expect(firstLine('   \n  ')).toBe('')
  })
})

describe('AG-005 / 相位历史', () => {
  /* mock 模式下 useAppStore 装的是 DEFAULT_THREADS，借它第一条来测（别自己编 id） */
  let threadId = ''

  beforeEach(() => {
    threadId = useAppStore.getState().threads[0]?.id ?? ''
    expect(threadId).not.toBe('')
    useAppStore.setState((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, phaseHistory: [] } : t)),
    }))
  })

  const history = () =>
    useAppStore.getState().threads.find((t) => t.id === threadId)?.phaseHistory ?? []

  it('记下走过的相位', () => {
    useAppStore.getState().setThreadPhase(threadId, 'preparing')
    useAppStore.getState().setThreadPhase(threadId, 'planning')
    expect(history()).toEqual(['preparing', 'planning'])
  })

  it('★ 相邻重复不记 —— executing 在一轮里会反复转移', () => {
    useAppStore.getState().setThreadPhase(threadId, 'executing')
    useAppStore.getState().setThreadPhase(threadId, 'executing')
    useAppStore.getState().setThreadPhase(threadId, 'executing')
    expect(history().filter((p) => p === 'executing')).toHaveLength(1)
  })

  it('不相邻的重复要记（执行 → 验证 → 再执行是真实发生的）', () => {
    useAppStore.getState().setThreadPhase(threadId, 'executing')
    useAppStore.getState().setThreadPhase(threadId, 'verifying')
    useAppStore.getState().setThreadPhase(threadId, 'executing')
    expect(history().filter((p) => p === 'executing')).toHaveLength(2)
  })

  it('有上限，长任务不会把历史堆成无限长', () => {
    for (let i = 0; i < 60; i += 1) {
      useAppStore.getState().setThreadPhase(threadId, i % 2 === 0 ? 'executing' : 'verifying')
    }
    expect(history().length).toBeLessThanOrEqual(24)
  })
})

describe('AG-005 / 接线守卫', () => {
  it('★ TaskBanner 真的把时间线放进去了', () => {
    const src = read('components/chat/TaskBanner.tsx')
    expect(src).toContain("import { ProgressTimeline } from './ProgressTimeline'")
    expect(src).toContain('<ProgressTimeline')
  })

  it('★ 时间线的三个数据源都**真的传进去了**（不是只有个名字在旁边）', () => {
    const src = read('components/chat/TaskBanner.tsx')
    /*
     * 这里断言的是**具体的传参表达式**，不是「关键词出现过」。
     * 变异测试抓到过一次：把 `phases={phases ?? []}` 换成
     * `phases={phases ? [] : []}`（时间线永远收不到相位），
     * 只断言 `toContain('phaseHistory')` 的话照样绿 ——
     * 名字在 picker 里出现 ≠ 值真的传给了组件。
     */
    expect(src).toContain('phases={phases ?? []}')
    expect(src).toContain('steps={tasks[0].steps}')
    expect(src).toContain('plan={tasks[0].plan}')
  })

  it('★ 不显示内部思考 —— 时间线里不该出现 reasoning', () => {
    const src = read('components/chat/ProgressTimeline.tsx')
    expect(src).not.toContain('reasoning')
  })

  it('★ 失败那行带原因（要求里明确写了「失败步骤保留原因」）', () => {
    const src = read('components/chat/ProgressTimeline.tsx')
    expect(src).toContain('失败：')
  })

  it('★ 工具结束时刷新任务台账 —— 否则时间线的动作行永远是空的', () => {
    /*
     * 真机验证抓到过：`steps` 来自 useTaskStore.unfinished，那个只在
     * activeStatus 变化时刷新，而工具执行期间 status 不变 →
     * 时间线只有阶段行、没有动作行。修法是工具事件里主动 refresh。
     */
    const src = read('stores/thread/streamEvents.ts')
    const block = src.slice(src.indexOf("case 'agent.tool.completed'"))
    expect(block.slice(0, 1400)).toContain('useTaskStore.getState().refresh()')
  })

  it('★ 相位历史是事件驱动记的（setThreadPhase 里），不是渲染层自己推断', () => {
    const src = read('stores/useAppStore.ts')
    expect(src).toContain('phaseHistory')
    expect(src).toContain('history[history.length - 1] === phase')
  })
})
