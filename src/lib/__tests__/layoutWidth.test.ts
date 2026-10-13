import { describe, expect, it } from 'vitest'
import { rightPanelMaxShown } from '@/lib/layoutWidth'
import { LAYOUT } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   右栏宽度上限（纯函数）

   这一组钉的是「右栏拖宽不许把中栏压没」：
   上限 = 窗口 − 侧栏 − 中栏保底，且不低于下限、坏值保守。
   ══════════════════════════════════════════════════════════════ */

const RESERVE = LAYOUT.centerReserve
const MIN = LAYOUT.rightPanel.min

describe('rightPanelMaxShown', () => {
  it('★ 窗口 1920 + 侧栏 240 → 上限 = 1920 - 240 - 680 = 1000', () => {
    expect(
      rightPanelMaxShown({ windowWidth: 1920, sidebarWidth: 240, reserve: RESERVE, minShown: MIN }),
    ).toBe(1000)
  })

  it('★ 窗口越窄上限越小（中栏保底不被吃掉）', () => {
    const wide = rightPanelMaxShown({
      windowWidth: 1920,
      sidebarWidth: 240,
      reserve: RESERVE,
      minShown: MIN,
    })
    const narrow = rightPanelMaxShown({
      windowWidth: 1280,
      sidebarWidth: 240,
      reserve: RESERVE,
      minShown: MIN,
    })
    expect(narrow).toBeLessThan(wide)
    expect(narrow).toBe(1280 - 240 - RESERVE)
  })

  it('★ 侧栏占得越多，右栏能拖得越窄（两个写死栏位一起算）', () => {
    const withNarrowSidebar = rightPanelMaxShown({
      windowWidth: 1600,
      sidebarWidth: 220,
      reserve: RESERVE,
      minShown: MIN,
    })
    const withWideSidebar = rightPanelMaxShown({
      windowWidth: 1600,
      sidebarWidth: 320,
      reserve: RESERVE,
      minShown: MIN,
    })
    expect(withNarrowSidebar - withWideSidebar).toBe(100)
  })

  it('★ 窗口极窄时不低于下限（右栏不会缩成 0，手柄仍抓得住）', () => {
    expect(
      rightPanelMaxShown({ windowWidth: 900, sidebarWidth: 240, reserve: RESERVE, minShown: MIN }),
    ).toBe(MIN)
  })

  it('★ 拿不到窗口宽（0 / NaN / undefined）→ 保守退回下限', () => {
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        rightPanelMaxShown({
          windowWidth: bad,
          sidebarWidth: 240,
          reserve: RESERVE,
          minShown: MIN,
        }),
      ).toBe(MIN)
    }
  })

  it('侧栏宽脏值当作 0（不让一个坏值把上限算错方向）', () => {
    expect(
      rightPanelMaxShown({
        windowWidth: 1600,
        sidebarWidth: Number.NaN,
        reserve: RESERVE,
        minShown: MIN,
      }),
    ).toBe(1600 - RESERVE)
  })
})
