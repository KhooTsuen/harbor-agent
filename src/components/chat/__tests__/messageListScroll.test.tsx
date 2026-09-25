import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../MessageList'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   流式期间的滚动：用户可以往上滚

   用户报：「正文消息生成中的时候没办法用鼠标上下滑动，被固定到了最底下」。

   根因：流式期间有一层「每帧兜底」的 rAF —— 它只要看到没贴底就把 scrollTop
   拽回底部。用户往上滚一点点，16ms 后又被拽回，`distance` 永远到不了 onScroll
   里的离开阈值（160px），于是 pinned 永远是 true，等于滚不动。

   修法是：用户滚轮往上（deltaY < 0）就**立刻**解锁（pinned=false），
   并把「回到底部」按钮亮出来。这里钉的就是「滚轮往上 → 按钮出现」这条链路。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const streamingMsg: Message = {
  id: 'a1',
  threadId: 't1',
  role: 'assistant',
  content: '正在生成……',
  kind: 'text',
  status: 'streaming',
  timestamp: 1,
}

beforeEach(() => {
  /* jsdom 没有 ResizeObserver —— 组件挂载时会建一个 */
  class RO {
    observe() {}
    disconnect() {}
  }
  ;(globalThis as never as { ResizeObserver: unknown }).ResizeObserver = RO

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(messages: Message[]): void {
  act(() => {
    root.render(<MessageList messages={messages} />)
  })
}

describe('流式期间往上滚', () => {
  it('★ 滚轮往上（deltaY < 0）→ 解锁贴底，出现「回到底部」按钮', () => {
    render([streamingMsg])
    expect(container.textContent ?? '').not.toContain('回到底部')

    const scroller = container.querySelector('div.overflow-y-auto')
    expect(scroller).toBeTruthy()
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    })

    expect(container.textContent ?? '').toContain('回到底部')
  })

  it('滚轮往下（deltaY > 0）不解锁（用户只是往下看）', () => {
    render([streamingMsg])
    const scroller = container.querySelector('div.overflow-y-auto')
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
    })
    expect(container.textContent ?? '').not.toContain('回到底部')
  })

  it('★ 点「回到底部」重新贴底，按钮收起', () => {
    render([streamingMsg])
    const scroller = container.querySelector('div.overflow-y-auto')
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    })
    expect(container.textContent ?? '').toContain('回到底部')
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('回到底部'))
        ?.click()
    })
    expect(container.textContent ?? '').not.toContain('回到底部')
  })
})
