import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bottomDistance,
  contentChildren,
  dims,
  fixture,
  layout,
  render,
  setup,
  teardown,
  userScrollTo,
  viewportTopOf,
  wheel,
} from './scrollHarness'
import type { Message } from '@/types'
import { useScrollStore } from '@/stores/useScrollStore'

/* ══════════════════════════════════════════════════════════════
   切走再回来：回到**同一条消息**，不是回到同一个像素

   旧实现只记 scrollTop，而切回来时 MessageList 把渲染窗口重置成最近 6 条、
   最多自动补到 24 条 —— 用户原来看到的那条多半**还没渲染**，同一个像素
   落在另一段内容上（真机表现：画面跳到别处 / 停在一处陌生位置）。

   现在记的是消息锚点（id + 相对视口偏移 + 下标），要求：
     · 在阅读历史 → 回到同一条消息、接近同一行；窗口按需扩到盖住它
     · 在跟最新   → 回来还在底部（不把所有对话都拽到历史位置）
     · 恢复没完成不写视图、也不宣告成功；用户一动手立刻作废

   ★ 这里用的是真的 MessageList（真分片渲染、真 MessageItem）、真的
     useScrollStore，只有「尺子」是假的（jsdom 没有布局，见 scrollHarness）。
     分片渲染靠 setTimeout 推进，所以每个用例用假定时器 + `pump()`。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

/** 造 n 条消息：偶数答、奇数问，正文都不同（好认） */
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

/** 给当前渲染出来的消息铺高度（每条一样高，好算），并让总高度等于它们之和 */
function layoutMessages(height: number): void {
  layout(contentChildren().map(() => height))
}

/**
 * 推进一步：先按当前渲染出来的消息铺高度（真机上 DOM 一挂上浏览器就布局），
 * 再检查条件、推进分片定时器。
 *
 * ★ 顺序不能反：切回来时窗口是**一次摆好**的（按离开时的条数），条件第一轮就成立；
 *   若先判条件再铺布局，这一轮就一次都不会铺，恢复永远等不到高度。
 */
function pump(height: number, cond: () => boolean, max = 200): void {
  /* 第一轮先铺：切回来时窗口是**一次摆好**的（按离开时的条数），条件可能一上来就成立 ——
     若先判条件再铺布局，这一轮就一次都不会铺，恢复永远等不到高度 */
  layoutMessages(height)
  for (let i = 0; i < max && !cond(); i += 1) {
    act(() => vi.advanceTimersByTime(20))
    layoutMessages(height)
  }
}

function renderedIds(): string[] {
  return [...document.querySelectorAll('[data-message-id]')].map(
    (el) => el.getAttribute('data-message-id') ?? '',
  )
}

/** 某条消息此刻在视口里的位置（= 用户眼睛看到的那一行） */
function viewTopOf(messageId: string): number {
  const el = document.querySelector(`[data-message-id="${messageId}"]`)
  if (!el) throw new Error(`这条消息没渲染：${messageId}`)
  return viewportTopOf(el)
}

/** 点「载入更早」直到不剩隐藏消息（真机上就是点了若干次） */
function loadAllEarlier(height: number): void {
  for (let i = 0; i < 40; i += 1) {
    pump(height, () => renderedIds().length >= 52, 40)
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('载入更早'),
    )
    if (!btn) return
    act(() => (btn as HTMLButtonElement).click())
  }
}

/** 打开 A、摊开 52 条、停在「第 26 条上方 133px」处，返回离开时的视口位置 */
function readInHistory(): { A: Message[]; atLeave: number } {
  const A = conv('A', 52)
  render(A, 'A')
  layoutMessages(400)
  loadAllEarlier(400)
  expect(renderedIds()).toHaveLength(52)
  userScrollTo(dims.scrollTop + viewTopOf('A-m25') + 133)
  return { A, atLeave: viewTopOf('A-m25') }
}

describe('切走再回来：按消息锚点恢复（50 条以上、翻过历史）', () => {
  it('★ A 停在较早消息中段 → A→B→A 回到同一条消息、接近同一行', () => {
    vi.useFakeTimers()
    try {
      const { A, atLeave } = readInHistory()
      expect(atLeave).toBeLessThan(0) // 那条消息的顶已经滚到视口上方

      render(conv('B', 6), 'B') // 切到 B
      layoutMessages(300)
      expect(renderedIds().some((id) => id.startsWith('A-'))).toBe(false)

      render(A, 'A') // 切回 A
      pump(400, () => renderedIds().includes('A-m25'))
      expect(renderedIds()).toContain('A-m25') // 窗口按需扩到了他当时那一带
      expect(viewTopOf('A-m25')).toBeCloseTo(atLeave, 0) // ★ 同一条消息、同一行
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 切回来第一帧还没铺高度 → 不许提前用碰巧能用的 scrollTop 宣告成功', () => {
    vi.useFakeTimers()
    try {
      const { A, atLeave } = readInHistory()
      render(conv('B', 4), 'B')
      layoutMessages(300)

      render(A, 'A') // 这一帧还没铺高度（新渲染的消息全都 0 高）
      /* 还没恢复完 —— 关键是**不能**因为「此刻 scrollTop 装得下」就结账 */
      if (renderedIds().includes('A-m25')) expect(viewTopOf('A-m25')).not.toBeCloseTo(atLeave, 0)
      pump(400, () => renderedIds().includes('A-m25'))
      layoutMessages(400) // 铺出来（= 真机上分片渲染完成）
      expect(viewTopOf('A-m25')).toBeCloseTo(atLeave, 0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('跟最新的人回来还在最新', () => {
  it('★ A 在底部跟随 → A→B→A 仍在底部（不强制滚到历史）', () => {
    vi.useFakeTimers()
    try {
      render(conv('A', 52), 'A')
      layoutMessages(400)
      expect(bottomDistance()).toBe(0) // 打开即 FOLLOW

      render(conv('B', 5), 'B')
      layoutMessages(300)
      render(conv('A', 52), 'A')
      layoutMessages(400)

      expect(bottomDistance()).toBe(0) // ★ 仍贴底
      /* 也没顺手把整段历史摊开（跟最新的人只需要最近那一口 + 自动补到 24） */
      expect(renderedIds().length).toBeLessThanOrEqual(24)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('离开期间内容变化 / 目标被删', () => {
  it('★ 离开期间 A 新增消息（高度也变了）→ 回来仍是同一条消息，不跳到另一条', () => {
    vi.useFakeTimers()
    try {
      const { atLeave } = readInHistory()
      render(conv('B', 3), 'B')
      layoutMessages(300)
      /* A 在后台多了两条（任务跑完 / 新消息落盘），每条也变高了 */
      render(conv('A', 54), 'A')
      pump(520, () => renderedIds().includes('A-m25'))
      expect(viewTopOf('A-m25')).toBeCloseTo(atLeave, 0) // 锚点仍是那条消息
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 目标消息被删 → 落到同下标的邻居，界面稳定、不跳最新', () => {
    vi.useFakeTimers()
    try {
      const { A, atLeave } = readInHistory()
      render(conv('B', 3), 'B')
      layoutMessages(300)
      const without = A.filter((m) => m.id !== 'A-m25') // 那条被删了
      render(without, 'A')
      pump(400, () => renderedIds().includes('A-m26'))

      const shown = renderedIds()
      expect(shown).not.toContain('A-m25')
      expect(bottomDistance()).toBeGreaterThan(0) // 不是贴底
      /* 落在同下标的邻居上（原来第 26 条位置现在是 A-m26），而不是跳回最新 */
      expect(viewTopOf('A-m26')).toBeCloseTo(atLeave, 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 空对话 / 短对话 / 还没有锚点的老会话：不炸、行为不变', () => {
    render([], 'A')
    render(conv('B', 2), 'B')
    layoutMessages(400)
    expect(bottomDistance()).toBe(0)

    /* 老记忆只有像素（没有 anchor 字段）→ 退回像素口径 */
    useScrollStore.setState({
      byThread: { C: { mode: 'free', top: 200, anchor: null } },
    })
    render(conv('C', 4), 'C')
    layoutMessages(400)
    expect(renderedIds()).toHaveLength(4)
    expect(bottomDistance()).toBeGreaterThan(0) // 用像素恢复，没被拽到底
  })
})

describe('异步竞态的边界', () => {
  it('★ A→B→A 快速连切：B 不许拿到 A 的位置', () => {
    vi.useFakeTimers()
    try {
      const { A, atLeave } = readInHistory()
      render(conv('B', 6), 'B') // 立刻切走
      layoutMessages(300)
      expect(bottomDistance()).toBe(0) // B 首次打开 = FOLLOW，没被 A 的历史位置污染

      render(A, 'A')
      pump(400, () => renderedIds().includes('A-m25'))
      expect(viewTopOf('A-m25')).toBeCloseTo(atLeave, 0) // 仍是锚点算出来的位置
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 恢复没完成时用户立刻滚动 → 程序不再把他拉回旧位置', () => {
    vi.useFakeTimers()
    try {
      const { A, atLeave } = readInHistory()
      const restoreTop = dims.scrollTop
      render(conv('B', 3), 'B')
      layoutMessages(300)

      render(A, 'A') // 恢复挂着
      wheel(-1) // 用户一动手 → 未完成的恢复作废
      userScrollTo(40) // 他自己滚到了别处
      pump(400, () => renderedIds().includes('A-m25'))
      layoutMessages(400)

      /* 程序没有强行对位：目标消息不在离开时那一行，用户的位置说了算 */
      expect(viewTopOf('A-m25')).not.toBeCloseTo(atLeave, 0)
      expect(dims.scrollTop).not.toBe(restoreTop)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('长对话仍受渲染限制（不为了修滚动放开性能闸门）', () => {
  it('★ 1000 条会话切回来：窗口有上限，不会一次摊开整段历史', () => {
    vi.useFakeTimers()
    try {
      const A = conv('A', 1000)
      render(A, 'A')
      layoutMessages(100)
      loadAllEarlier(100)
      /* 滚到非常早的地方（第 10 条）：锚点比窗口上限还远 */
      userScrollTo(100 * 10 + 33)

      render(conv('B', 3), 'B')
      layoutMessages(300)
      render(A, 'A')
      pump(100, () => renderedIds().length >= 96)

      /* 窗口被上限截住（≤ 96 条），而不是 1000 条全摊开 */
      expect(renderedIds().length).toBeLessThanOrEqual(96)
      expect(renderedIds().length).toBeGreaterThan(24)
    } finally {
      vi.useRealTimers()
    }
  })
})
