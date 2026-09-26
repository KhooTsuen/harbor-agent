import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../MessageList'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   流式期间的滚动：用户可以往上滚

   用户报：「正文消息生成中的时候没办法用鼠标上下滑动，被固定到了最底下」。

   现在这层是显式状态机（`hooks/useAutoScroll.ts`）：滚轮往上 → 立刻 FREE，
   而 FREE 的含义是「程序一行都不写」—— 被拽回在机制上就不可能发生。
   这里钉的是它最外层的那条链路：滚轮往上 → 按钮出现 → 点按钮 → 回去。

   注：jsdom 没有布局（scrollHeight/clientHeight 恒为 0），所以「向下滚」在
   这里等价于「已经在真正的底」—— 按迁移规则 3 仍是 FOLLOW、按钮不出现。
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
  it('★ 滚轮往上（deltaY < 0）→ 进入 FREE，出现「回到底部」按钮', () => {
    render([streamingMsg])
    expect(container.textContent ?? '').not.toContain('回到底部')

    const scroller = container.querySelector('div.overflow-y-auto')
    expect(scroller).toBeTruthy()
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    })

    expect(container.textContent ?? '').toContain('回到底部')
  })

  it('滚轮往下：已经在真正的底（≤4px）→ 仍是 FOLLOW，按钮不出现', () => {
    render([streamingMsg])
    const scroller = container.querySelector('div.overflow-y-auto')
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
    })
    expect(container.textContent ?? '').not.toContain('回到底部')
  })

  it('★ 点「回到底部」回 FOLLOW，按钮收起', () => {
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
