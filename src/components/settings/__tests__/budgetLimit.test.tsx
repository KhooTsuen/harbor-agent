import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   用量闸的两个输入框：**改了就得存下来**（真渲染）

   真机逮到的（2026-09-28）：原来只挂 `onBlur` 提交 ——
   填完上限**直接关掉设置面板**（点 X 或按 Esc）时 blur 不一定来
   （面板是隐藏、不是卸载），这个值就永远不提交。
   用户看到的是「填了、看着也在，重新打开又空了」——
   和这个月栽的「写了不生效」是同一类病。

   这一组两个都钉：防抖到点要存、「没到点就关面板」也要存。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  pushed: [] as Array<Record<string, unknown>>,
  limits: { enabled: true, dailyTokens: 0, monthlyTokens: 0, onExceed: 'block' },
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    isElectron: true,
    loadConfig: async () => ({ limits: { ...h.limits } }),
    /* 假内核：记下交上来的 patch，并按真实内核那样深合并回来 */
    pushConfig: async (patch: Record<string, unknown>) => {
      h.pushed.push(patch)
      h.limits = { ...h.limits, ...(patch.limits as typeof h.limits) }
      return { limits: { ...h.limits } }
    },
  }
})

import { useConfigStore } from '@/stores/useConfigStore'
import { BudgetLimit } from '../tabs/BudgetLimit'

let container: HTMLDivElement
let root: Root

/** 往输入框里打字：React 认的是原生 setter + input 事件 */
function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const dailyBox = (): HTMLInputElement =>
  container.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')[0]

/** 最后一次交上去的 limits（store 合并后的完整对象） */
const limitsOf = (): typeof h.limits =>
  (h.pushed.at(-1) as { limits: typeof h.limits } | undefined)?.limits ?? h.limits

describe('用量闸输入框', () => {
  beforeEach(async () => {
    h.pushed = []
    h.limits = { enabled: true, dailyTokens: 0, monthlyTokens: 0, onExceed: 'block' }
    vi.useFakeTimers()
    useConfigStore.setState({ config: { limits: { ...h.limits } } as never })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<BudgetLimit />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('★ 打完字（不等失焦）到点就写回配置', async () => {
    type(dailyBox(), '2000000')
    expect(h.pushed, '还没到防抖时间就不该写').toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(800)
      await Promise.resolve()
    })
    /* store 会按**最新配置**合并（只交涉改的那个字段，其余原样带过来） */
    expect(limitsOf()).toEqual({
      enabled: true,
      dailyTokens: 2_000_000,
      monthlyTokens: 0,
      onExceed: 'block',
    })
  })

  it('★ 打完字立刻关面板（没到防抖点）—— 也要写回去，不许白填', async () => {
    type(dailyBox(), '3000000')
    /* 模拟「点 X 关掉」：组件卸载 */
    act(() => root.unmount())
    await act(async () => {
      await Promise.resolve()
    })
    expect(limitsOf().dailyTokens).toBe(3_000_000)
    /* 让 afterEach 的 unmount 不至于二次卸载 */
    root = createRoot(document.createElement('div'))
  })

  it('另一个字段不会被旧快照写回去（只改了每天上限）', async () => {
    type(dailyBox(), '1500')
    await act(async () => {
      vi.advanceTimersByTime(800)
      await Promise.resolve()
    })
    expect(limitsOf()).toEqual({
      enabled: true,
      dailyTokens: 1500,
      /* 每月上限还是原值（以前会拿旧快照把别的字段写回旧值） */
      monthlyTokens: 0,
      onExceed: 'block',
    })
  })
})
