import { describe, expect, it } from 'vitest'
import {
  CLICKS_NEEDED,
  CLICK_WINDOW_MS,
  createBrandClickState,
  registerBrandClick,
} from '../nightVoyage'

/* ══════════════════════════════════════════════════════════════
   夜航彩蛋：连点计数（设计文档 §13.3）

   「2 秒窗口内 5 次」—— 日常操作不会误触；触发后清零，
   再连点 5 次算下一轮（切回默认）。
   ══════════════════════════════════════════════════════════════ */

describe('夜航彩蛋 / 连点规则', () => {
  it('2 秒窗口内连点 5 次 → 触发', () => {
    let state = createBrandClickState()
    let fired = false
    for (let i = 0; i < CLICKS_NEEDED; i += 1) {
      const step = registerBrandClick(state, 1000 + i * 100)
      state = step.state
      fired = step.fired
    }
    expect(fired).toBe(true)
    /* 触发后清零 —— 下一轮重新数 */
    expect(state.at).toEqual([])
  })

  it('点 4 次不触发（差一次就是不开）', () => {
    let state = createBrandClickState()
    for (let i = 0; i < CLICKS_NEEDED - 1; i += 1) {
      state = registerBrandClick(state, 1000 + i * 10).state
    }
    expect(state.at.length).toBe(CLICKS_NEEDED - 1)
  })

  it('慢悠悠点 5 次（每次隔超过窗口）不触发 —— 日常操作不会误触', () => {
    let state = createBrandClickState()
    let fired = false
    for (let i = 0; i < CLICKS_NEEDED; i += 1) {
      const step = registerBrandClick(state, 1000 + i * (CLICK_WINDOW_MS + 50))
      state = step.state
      fired = step.fired
    }
    expect(fired).toBe(false)
  })

  it('窗口是 2 秒（文档 §14 的冷却数字）', () => {
    expect(CLICK_WINDOW_MS).toBe(2000)
  })
})
