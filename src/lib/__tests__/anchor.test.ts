import { describe, expect, it } from 'vitest'
import {
  ANCHOR_GAP,
  ANCHOR_MIN_BOTTOM,
  ANCHOR_MIN_TOP,
  anchoredBottom,
  anchoredMaxHeight,
  anchoredPlacement,
} from '../anchor'

/* ══════════════════════════════════════════════════════════════
   权限确认面板「贴在输入区上方」的定位数学

   背景：原来是用一个写死的 CSS 变量猜输入框高度（`--composer-shell-h: 135px`），
   输入框一长高（多行 / 附件 / 排队提示 / 权限条自己）面板就压到输入框上。
   现在按真实 rect 每帧算一次 —— 这里把那段数学钉住。
   ══════════════════════════════════════════════════════════════ */

describe('anchor / 贴在上方的位置', () => {
  it('常规：面板底边落在输入区顶边上方 gap 处', () => {
    /* 视口 800 高、输入区顶边在 700 → 面板底边距底部 100 + gap */
    expect(anchoredBottom(700, 800)).toBe(100 + ANCHOR_GAP)
  })

  it('★ 输入框长高（top 变小）→ 面板跟着往上走', () => {
    const before = anchoredBottom(700, 800)
    const after = anchoredBottom(600, 800)
    expect(after - before).toBe(100)
  })

  it('★ 高面板不会把自己顶出视口上沿', () => {
    /* 输入区偏上（top=300）而面板 480 高：位置会被压回视口内 */
    const bottom = anchoredBottom(300, 800, 480)
    const panelTop = 800 - bottom - 480
    expect(panelTop).toBeGreaterThanOrEqual(ANCHOR_MIN_TOP)
    expect(bottom).toBeLessThanOrEqual(800 - 480 - ANCHOR_MIN_TOP)
  })

  it('面板不高时按正常位置走（不被上限干扰）', () => {
    expect(anchoredBottom(700, 800, 120)).toBe(100 + ANCHOR_GAP)
  })

  it('输入区贴着视口顶：至少还能停在 min-bottom 上，不返回负数或超界值', () => {
    const bottom = anchoredBottom(0, 800, 200)
    expect(bottom).toBeGreaterThanOrEqual(ANCHOR_MIN_BOTTOM)
    expect(bottom).toBeLessThanOrEqual(800 - 200)
  })

  it('取整（子像素 rect 不传一堆小数下去）', () => {
    expect(Number.isInteger(anchoredBottom(700.4, 800.6, 100.2))).toBe(true)
  })

  it('拿不到尺寸时给安全值，不返回 NaN', () => {
    expect(anchoredBottom(Number.NaN, 800)).toBe(ANCHOR_MIN_BOTTOM)
    expect(anchoredBottom(700, Number.NaN)).toBe(ANCHOR_MIN_BOTTOM)
    expect(anchoredBottom(700, 800, Number.NaN)).toBe(100 + ANCHOR_GAP)
  })
})

describe('anchor / 完整位置（垂直 + 水平）', () => {
  const composer = { top: 856, left: 520, width: 760 }
  const viewport = { width: 1920, height: 1040 }

  it('★ 水平按输入区的左边缘与宽度来（不是在窗口里居中）', () => {
    const p = anchoredPlacement(composer, viewport, 181)
    expect(p.left).toBe(520)
    expect(p.width).toBe(760)
  })

  it('★ 输入区不在窗口正中时，左边就跟着偏（实测差 60px 就是这里）', () => {
    const centered = anchoredPlacement({ top: 856, left: 700, width: 760 }, viewport, 181)
    /* 窗口居中的话左边缘会是 (1920-760)/2 = 580，而实际是 700 */
    expect(centered.left).toBe(700)
    expect(centered.left).not.toBe(580)
  })

  it('垂直部分与 anchoredBottom 一致', () => {
    const p = anchoredPlacement(composer, viewport, 181)
    expect(p.bottom).toBe(anchoredBottom(composer.top, viewport.height, 181))
  })

  it('输入区比窗口还宽时不会溢出（贴左、占满）', () => {
    const p = anchoredPlacement({ top: 500, left: 0, width: 2400 }, { width: 1920, height: 1040 })
    expect(p.width).toBe(1920)
    expect(p.left).toBe(0)
  })

  it('负数/拿不到值时不会算出负的左边', () => {
    const p = anchoredPlacement(
      { top: 500, left: Number.NaN, width: Number.NaN },
      { width: 1920, height: 1040 },
    )
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.width).toBeGreaterThanOrEqual(0)
  })
})

describe('anchor / 上方还剩多少高度', () => {
  it('按输入区顶边算可用高度', () => {
    expect(anchoredMaxHeight(700)).toBe(700 - ANCHOR_GAP - 24)
  })

  it('空间不够时返回 0（不返回负数）', () => {
    expect(anchoredMaxHeight(10)).toBe(0)
    expect(anchoredMaxHeight(0)).toBe(0)
  })

  it('拿不到尺寸时返回 0', () => {
    expect(anchoredMaxHeight(Number.NaN)).toBe(0)
  })
})
