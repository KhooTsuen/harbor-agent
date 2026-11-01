import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contentChildren,
  dims,
  fixture,
  layout,
  render,
  setup,
  teardown,
  userScrollTo,
  viewportTopOf,
} from './scrollHarness'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   切回来「停得住」：窗口补的过程中一次都不许写视图

   真机表现（用户原话）：「每次切回来都是重复的从下往上滑，而且没回到原位置」。

   机制：窗口是一片片补的。目标消息一开始就落在窗口里时（他停在靠末尾、但已经
   往上翻了一点 —— 最常见的情况），每补一片，目标**上方**就多一段内容，落点
   跟着变大一次。旧实现在每片之后都落位，于是屏幕一段段往上跳；而且每一跳都
   重新贴锚点，最后停在哪儿要看补到第几片时恰好「对上 ±1px」，所以也回不到原位。

   这里钉的不是「最终位置对不对」（scrollReturn.test 已钉），而是**写了几次、
   写的时候窗口补完没有**：补的过程中 0 次，补完 1 次，之后不再动。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

function conv(threadId: string, n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    fixture({
      id: `${threadId}-m${i}`,
      threadId,
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `${threadId} 第 ${i} 条`,
    }),
  )
}

function layoutMessages(height: number): void {
  layout(contentChildren().map(() => height))
}

function renderedIds(): string[] {
  return [...document.querySelectorAll('[data-message-id]')].map(
    (el) => el.getAttribute('data-message-id') ?? '',
  )
}

/** 点「载入更早」直到窗口展开到 n 条（真机上就是点了若干次） */
function loadEarlierUntil(n: number, height: number): void {
  for (let i = 0; i < 40; i += 1) {
    for (let k = 0; k < 40 && renderedIds().length < n; k += 1) {
      layoutMessages(height)
      act(() => vi.advanceTimersByTime(20))
    }
    if (renderedIds().length >= n) return
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('载入更早'),
    )
    if (!btn) return
    act(() => (btn as HTMLButtonElement).click())
  }
}

describe('切回来的落位次数', () => {
  it('★ 窗口补的过程中不写视图，补完只写一刀，然后停在离开时那一行', () => {
    vi.useFakeTimers()
    try {
      /* 记下「每次写 scrollTop 那一刻渲染了多少条」—— 写的时候窗口补完了没有，看这个 */
      const trace: number[] = []
      const inner = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')?.set as
        ((v: number) => void) | undefined
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get: () => dims.scrollTop,
        set: (value: number) => {
          trace.push(document.querySelectorAll('[data-message-id]').length)
          inner?.call(document.documentElement, value)
        },
      })

      const A = conv('A', 52)
      render(A, 'A')
      layoutMessages(400)
      loadEarlierUntil(52, 400) /* 他一路「载入更早」翻到了开头 */
      const m47 = document.querySelector('[data-message-id="A-m47"]') as HTMLElement
      userScrollTo(dims.scrollTop + viewportTopOf(m47) + 99) /* 停在靠末尾、往上翻了一点 */
      const atLeave = viewportTopOf(m47)
      expect(atLeave).toBeLessThan(0)

      render(conv('B', 6), 'B')
      layoutMessages(300)
      trace.length = 0 /* 之后只看切回来这一段 */

      /* 切回 A：逐帧推进（每帧重铺布局 = 真机上浏览器做完 layout） */
      render(A, 'A')
      for (let i = 0; i < 60; i += 1) {
        layoutMessages(400)
        act(() => vi.advanceTimersByTime(20))
      }

      const shown = renderedIds()
      expect(shown).toContain('A-m47') /* 目标回到窗口里 */
      /* ★ 每一刀都发生在窗口补齐之后：边补边写就是那阵「从下往上反复滑」 */
      expect(trace.length).toBeGreaterThan(0)
      for (const ids of trace) expect(ids).toBe(shown.length)
      /* 落在离开时那一行 */
      const el = document.querySelector('[data-message-id="A-m47"]') as HTMLElement
      expect(viewportTopOf(el)).toBeCloseTo(atLeave, 0)

      /* 收敛之后不再动 */
      const settledTop = dims.scrollTop
      const settledWrites = trace.length
      for (let i = 0; i < 10; i += 1) {
        layoutMessages(400)
        act(() => vi.advanceTimersByTime(20))
      }
      expect(trace.length).toBe(settledWrites)
      expect(dims.scrollTop).toBe(settledTop)
    } finally {
      vi.useRealTimers()
    }
  })
})
