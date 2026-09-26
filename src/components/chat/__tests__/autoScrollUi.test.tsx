import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThinkBlock } from '../ProcessBlocks'
import {
  bottomDistance,
  clickButton,
  dims,
  fixture,
  grow,
  historyMsg,
  jumpVisible,
  pressKey,
  render,
  scroller,
  setup,
  streamingMsg,
  teardown,
  wheel,
  writes,
} from './scrollHarness'

/* ══════════════════════════════════════════════════════════════
   滚动状态机 —— 验收 i–k + 两个真机踩过的挂载坑

   i 的「帧间隔 P95」只能真机量（渲染层测不出来，见渲染层规矩），这里钉的是
   它能成立的前提：流式每一步只写一次 scrollTop（不抖、不额外重排）。
   ══════════════════════════════════════════════════════════════ */

beforeEach(setup)
afterEach(teardown)

describe('滚动状态机（验收 i–k / 挂载时序）', () => {
  it('i 4000 字量级流式（FOLLOW）：每步一刀贴底，没有多余写入', () => {
    render([historyMsg, streamingMsg])
    const before = writes.count
    for (let step = 0; step < 120; step += 1) grow(33) // 120 × 33px ≈ 4000 字的高度量级
    expect(writes.count - before).toBe(120) // 一步一刀：没有抖动式重写
    expect(dims.scrollTop).toBe(dims.contentHeight - dims.clientHeight)
    expect(jumpVisible()).toBe(false)
  })

  it('j 「回到底部」：FOLLOW 隐藏 / FREE 显示 / 点了回 FOLLOW', () => {
    render([historyMsg, streamingMsg])
    expect(jumpVisible()).toBe(false)

    wheel(-40)
    expect(jumpVisible()).toBe(true)

    clickButton('回到底部') // 迁移 5
    expect(jumpVisible()).toBe(false)
    expect(bottomDistance()).toBe(0)
    grow(70) // 回到 FOLLOW 后继续贴底
    expect(bottomDistance()).toBe(0)
  })

  it('k 非流式（静态消息）：打开即贴底；消息增删（程序行为）不改状态', () => {
    render([historyMsg])
    expect(bottomDistance()).toBe(0)
    expect(jumpVisible()).toBe(false)

    render([historyMsg, fixture({ id: 'm2', content: '第二段' })]) // 消息增多
    expect(jumpVisible()).toBe(false)
    expect(bottomDistance()).toBe(0)
  })

  it('键盘 PageUp / Home → FREE（迁移 1 的键位）', () => {
    render([historyMsg, streamingMsg])
    pressKey('PageUp')
    expect(jumpVisible()).toBe(true)
    clickButton('回到底部')
    expect(jumpVisible()).toBe(false)
    pressKey('Home')
    expect(jumpVisible()).toBe(true)
  })

  it('★ 空对话先渲染开屏 → 容器晚挂载：滚轮上滑照样能进 FREE', () => {
    render([], 't1') // 开屏：这一刻没有滚动容器
    expect(() => scroller()).toThrow()
    render([historyMsg, streamingMsg], 't1') // 第一条消息到了，容器才挂上
    scroller()

    wheel(-120)
    expect(jumpVisible()).toBe(true)
    const top = dims.scrollTop
    grow(200)
    expect(dims.scrollTop).toBe(top) // 晚挂载也拽不动了
  })

  it('★ 晚挂载后 scroll 监听也在：拖到中间 → FREE', () => {
    render([], 't1')
    render([historyMsg, streamingMsg], 't1')
    dims.scrollTop = 600
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(jumpVisible()).toBe(true)
  })

  it('单测里没有列表包裹时，思考块点击不报错（guard 为 null）', () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const r = createRoot(box)
    act(() => {
      r.render(<ThinkBlock text="思考内容" />)
    })
    act(() => {
      ;[...box.querySelectorAll('button')][0]?.click()
    })
    expect(box.textContent ?? '').toContain('思考')
    act(() => r.unmount())
    box.remove()
  })
})
