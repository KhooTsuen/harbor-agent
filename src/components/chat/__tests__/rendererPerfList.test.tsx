import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types'
import { MessageList } from '../MessageList'
import { installDomStubs } from './domStubs'

installDomStubs()

/* ══════════════════════════════════════════════════════════════
   AG-038 / 1000 条消息：渐增渲染（分片补上）
   （从 `rendererPerf.test.tsx` 拆出来 —— 那边顶到 300 行了）

   真机量过两件不同的事，别混：
     · 一口气画 200 条 = 14.3 万 DOM 节点、建完 **3.8 秒**一次性阻塞（切换对话就是这么卡的）
     · 一条消息约 700 个节点，所以「渲染窗口」本身就是流式能不能跑顺的前提
       （窗口 200 条时，长会话 + 流式会把主线程压死）

   所以判据是**条数**（确定、跨机器稳定），不是耗时 —— jsdom 里 1000 条全渲染也就
   几秒，拿时间当判据管不住（第一版就是这么写的，变异测试逮到过）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterAll(() => {
  act(() => root.unmount())
  container.remove()
})

let seq = 0
const message = (patch: Partial<Message> = {}): Message => ({
  id: `m${(seq += 1)}`,
  threadId: 't1',
  role: 'assistant',
  kind: 'text',
  content: '一句话回答。',
  status: 'sent',
  timestamp: 1700000000000 + seq,
  ...patch,
})

const rendered = () => container.querySelectorAll('[data-message-id]').length
const hasButton = () =>
  [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('载入更早的'))
const advance = (times: number, until?: () => boolean) => {
  for (let i = 0; i < times; i += 1) {
    if (until?.()) return
    act(() => {
      vi.advanceTimersByTime(20)
    })
  }
}

describe('AG-038 / 1000 条消息', () => {
  it('★ 1000 条消息：首屏只画一小口，其余分帧补上（不再一口气建 14 万节点）', () => {
    vi.useFakeTimers()
    try {
      const messages = Array.from({ length: 1000 }, () => message())
      const startedAt = performance.now()
      act(() => root.render(<MessageList messages={messages} conversationId="perf-1000" />))
      const firstMs = performance.now() - startedAt
      const firstNodes = container.querySelectorAll('*').length
      // eslint-disable-next-line no-console
      console.log(
        `[AG-038] 1000 条·首屏：${firstMs.toFixed(0)}ms · DOM ${firstNodes} 个 · 画了 ${rendered()} 条`,
      )

      expect(rendered(), `首屏画了 ${rendered()} 条`).toBeLessThanOrEqual(12)
      expect(firstNodes, `${firstNodes} 个节点`).toBeLessThan(1200)

      /* 后台按「每片 ≤12ms」补：片数要多（说明真的切成了小片），补到 24 就停手 */
      let slices = 0
      for (let i = 0; i < 400 && rendered() < 24; i += 1) {
        act(() => {
          vi.advanceTimersByTime(20)
        })
        slices += 1
      }
      // eslint-disable-next-line no-console
      console.log(
        `[AG-038] 补满之后：DOM ${container.querySelectorAll('*').length} 个 · 画了 ${rendered()} 条 / ${slices} 片`,
      )
      expect(rendered()).toBe(24)
      expect(slices, '分帧片数').toBeGreaterThanOrEqual(2)
      expect(container.querySelectorAll('*').length).toBeLessThan(4000)

      /* 补满之后才给出口；点了要真加载（而且也是分片的） */
      const more = [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('载入更早的'),
      )
      expect(more?.textContent).toContain('还有 976 条')
      act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      advance(400, () => rendered() >= 48)
      // eslint-disable-next-line no-console
      console.log(`[AG-038] 点「载入更早」之后：画了 ${rendered()} 条`)
      expect(rendered()).toBe(48)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('★ 补的过程中不给「载入更早」按钮（免得它一闪一闪）', () => {
    vi.useFakeTimers()
    try {
      render1000('perf-grow')
      expect(hasButton(), '首屏还在补的时候就有按钮').toBe(false)
      advance(60, () => rendered() >= 24)
      expect(hasButton(), '补满之后应该给出入口').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('★ 切对话会回到「一小口」（否则下一条又是 3.8 秒阻塞）', () => {
    vi.useFakeTimers()
    try {
      render1000('perf-a')
      advance(400, () => rendered() >= 24)
      expect(rendered()).toBe(24)

      render1000('perf-b')
      expect(rendered(), '切到另一条对话后还是画满').toBeLessThanOrEqual(12)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('★ 1000 条里滚动一次不该重排整棵树（耗时随数据线性，不退化成平方）', () => {
    act(() =>
      root.render(
        <MessageList
          messages={Array.from({ length: 1000 }, () => message())}
          conversationId="perf-scroll"
        />,
      ),
    )
    const scroller =
      container.querySelector('[data-message-scroller]') ?? container.firstElementChild

    const startedAt = performance.now()
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        scroller?.dispatchEvent(new Event('scroll'))
      }
    })
    const ms = performance.now() - startedAt
    // eslint-disable-next-line no-console
    console.log(
      `[AG-038] 20 次滚动事件：${ms.toFixed(0)}ms · DOM ${container.querySelectorAll('*').length} 个`,
    )
    expect(ms).toBeLessThan(1500)
  })
})

function render1000(conversationId: string): void {
  const messages = Array.from({ length: 1000 }, () => message())
  act(() => root.render(<MessageList messages={messages} conversationId={conversationId} />))
}
