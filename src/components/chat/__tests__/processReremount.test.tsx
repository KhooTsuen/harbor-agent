import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentChildren, fixture, layout, render, setup, teardown } from './scrollHarness'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   过程折叠区：手动展开 / 折叠要跟着「消息」走，不跟组件实例走

   切到别的对话时整棵消息树卸载，`ProcessPanel` 本地 `useState` 必然丢 ——
   这就是「切走再回来，手动展开的过程又收起来了」的原因。现在这份状态记在
   `useScrollStore.processOpen`（key = `threadId:messageId`）。

   ★ 失败 / 中断默认展开那条**不许回归**：没留痕时仍听 `defaultOpen`。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

const withProcess = (id: string, threadId: string): Message =>
  fixture({ id, threadId, content: '结论', reasoning: '思考过程', durationMs: 31000 })

const entry = (): HTMLButtonElement =>
  document.querySelector('button[aria-label="查看过程"]') as HTMLButtonElement

/** 切到另一条对话再切回来（整棵树卸载 → 重新挂载） */
function roundTrip(messages: Message[]): void {
  render([fixture({ id: 'B-1', threadId: 'B' })], 'B')
  layout(contentChildren().map(() => 300))
  render(messages, 'A')
  layout(contentChildren().map(() => 600))
}

describe('过程折叠区重新挂载', () => {
  it('★ 手动展开 → 切走再回来仍展开；手动折叠也保留', () => {
    const A = [withProcess('A-p1', 'A'), fixture({ id: 'A-p2', threadId: 'A' })]
    render(A, 'A')
    layout(contentChildren().map(() => 600))

    expect(entry().getAttribute('aria-expanded')).toBe('false') // 正常态默认收起
    act(() => entry().click())
    expect(entry().getAttribute('aria-expanded')).toBe('true')

    roundTrip(A)
    expect(entry().getAttribute('aria-expanded')).toBe('true') // ★ 仍展开

    act(() => entry().click()) // 用户手动折叠
    expect(entry().getAttribute('aria-expanded')).toBe('false')
    roundTrip(A)
    expect(entry().getAttribute('aria-expanded')).toBe('false') // ★ 仍折叠
  })

  it('★ 失败 / 中断默认展开的规矩不回归（用户没点过就听默认）', () => {
    const failed = fixture({
      id: 'A-f1',
      threadId: 'A',
      content: '失败了',
      reasoning: '思考',
      status: 'error',
    })
    const A = [failed, fixture({ id: 'A-f2', threadId: 'A' })]
    render(A, 'A')
    layout(contentChildren().map(() => 600))
    expect(entry().getAttribute('aria-expanded')).toBe('true') // 默认展开

    roundTrip(A)
    expect(entry().getAttribute('aria-expanded')).toBe('true') // 回来仍展开
  })
})
