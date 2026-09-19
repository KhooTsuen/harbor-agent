import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfTimeline } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   AG-037：性能面板（真渲染）

   文档要的数里，「Render Time」主进程测不到（它看不见「画上去没有」），
   所以由渲染层测：从**按下发送**到第一个字真的画在屏幕上。这里验三件事：

     · 面板把内核给的分段显示出来（模型 / 工具 / 搜索 / 上下文）
     · 没有数据时说「还没有数据」，不编
     · 首字上屏用的是 rAF（等一帧）——**不是**收到事件就立刻算 0
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ items: [] as PerfTimeline[] }))

vi.mock('@/lib/safetyApi', () => ({
  metricsRecent: async () => h.items,
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false }
})

import { usePerfStore } from '@/stores/usePerfStore'
import { PerfPanel } from '@/components/layout/state/PerfPanel'

let container: HTMLDivElement
let root: Root

const timeline = (patch: Partial<PerfTimeline> = {}): PerfTimeline => ({
  traceId: 't1',
  requestTime: 1000,
  firstFeedbackMs: 40,
  taskCreatedMs: 60,
  ttftMs: 1200,
  firstToolMs: 1500,
  totalMs: 4000,
  contextMs: 100,
  llmMs: 2200,
  llmCalls: 2,
  llmMaxMs: 1500,
  toolMs: 500,
  toolCalls: 2,
  searchMs: 0,
  searchCalls: 0,
  ...patch,
})

async function draw(): Promise<void> {
  await act(async () => root.render(<PerfPanel threadId="thread-1" />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.items = []
  usePerfStore.setState({ recent: [], firstPaintMs: null, sentAt: 0, loaded: false })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AG-037 / 性能面板', () => {
  it('★ 一段一段显示出来（模型 / 工具 / 上下文）', async () => {
    h.items = [timeline()]
    await draw()
    const text = container.textContent ?? ''
    expect(text).toContain('模型调用')
    expect(text).toContain('工具')
    expect(text).toContain('上下文构建')
    expect(text).toContain('2.2s')
    expect(text).toContain('500ms')
  })

  it('★ 有搜索才出现搜索那一段（没搜索不占地方）', async () => {
    h.items = [timeline()]
    await draw()
    expect(container.textContent).not.toContain('搜索')

    /* 同一个组件再渲染一次不会再拉一遍（effect 只在「跑完」时触发）——
       这里直接把 store 换掉，测的是渲染逻辑，不是拉取 */
    act(() => usePerfStore.setState({ recent: [timeline({ searchMs: 300, searchCalls: 1 })] }))
    expect(container.textContent).toContain('搜索')
  })

  it('多次模型调用会写次数（一次调用就不用写）', async () => {
    h.items = [timeline({ llmCalls: 3 })]
    await draw()
    expect(container.textContent).toContain('×3')
  })

  it('没有数据就说没有，不编', async () => {
    await draw()
    expect(container.textContent).toContain('还没有数据')
  })

  it('更早的几轮列在下面（对比用）', async () => {
    h.items = [timeline(), timeline({ traceId: 't0', totalMs: 9000 })]
    await draw()
    expect(container.textContent).toContain('更早')
    expect(container.textContent).toContain('9.0s')
  })

  it('★ 首字上屏用的是「等一帧」，不是收到就立刻算', async () => {
    /* 真跑一遍 store：rAF 由测试控制，不推进就一直是「还没上屏」 */
    let frame: (() => void) | null = null
    const spy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frame = () => cb(performance.now())
        return 1
      })

    usePerfStore.getState().beginRun(1000)
    usePerfStore.getState().markFirstContent()
    expect(usePerfStore.getState().firstPaintMs).toBeNull()
    act(() => frame?.())
    expect(usePerfStore.getState().firstPaintMs).toBeGreaterThan(0)
    spy.mockRestore()
  })

  it('一轮只记一次（后面来的字不会把上屏时间越推越晚）', async () => {
    let frames = 0
    const spy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frames += 1
        cb(performance.now())
        return 1
      })
    usePerfStore.getState().beginRun(1000)
    usePerfStore.getState().markFirstContent()
    const first = usePerfStore.getState().firstPaintMs
    usePerfStore.getState().markFirstContent()
    expect(usePerfStore.getState().firstPaintMs).toBe(first)
    expect(frames).toBe(1)
    spy.mockRestore()
  })
})
