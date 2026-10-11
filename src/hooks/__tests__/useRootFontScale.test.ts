import { describe, expect, it } from 'vitest'
import { scaleFromRootPx } from '../useRootFontScale'

/* ══════════════════════════════════════════════════════════════
   P4-3：右栏宽度随根字号缩放 —— 倍率换算的纯函数

   它决定栏宽乘以几。**默认缩放必须恰好等于 1**（否则默认态会位移，那是红线），
   非法 / 离奇的值必须退回 1（不能把一个坏值放大到撑爆窗口）。
   ══════════════════════════════════════════════════════════════ */

describe('P4-3 · 根字号倍率', () => {
  it('100% 缩放（16px）恰好等于 1 —— 默认态零位移', () => {
    expect(scaleFromRootPx(16)).toBe(1)
  })

  it('150% 缩放（24px）= 1.5；80% 缩放（12.8px）= 0.8', () => {
    expect(scaleFromRootPx(24)).toBe(1.5)
    expect(scaleFromRootPx(12.8)).toBe(0.8)
  })

  it('360px 栏宽：默认仍 360，150% 变 540', () => {
    expect(Math.round(360 * scaleFromRootPx(16))).toBe(360)
    expect(Math.round(360 * scaleFromRootPx(24))).toBe(540)
  })

  it('非法 / 离奇的值一律退回 1（不缩放）', () => {
    expect(scaleFromRootPx(Number.NaN)).toBe(1)
    expect(scaleFromRootPx(0)).toBe(1)
    expect(scaleFromRootPx(-16)).toBe(1)
    /* 超出 0.5x~3x 的当噪声 */
    expect(scaleFromRootPx(1000)).toBe(1)
    expect(scaleFromRootPx(1)).toBe(1)
  })
})
