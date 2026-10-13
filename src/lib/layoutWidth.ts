/* ══════════════════════════════════════════════════════════════
   右栏宽度上限 —— **唯一一处算法**

   背景（2026-10-13 用户报「右栏能不能再宽一点，但别压中栏」）：
   三栏是 flex 布局 —— 侧栏与右栏 `shrink-0`（写死 px），中栏（对话区）
   `flex-1 min-w-0`。也就是说**右栏宽多少，中栏就被挤掉多少**。
   而右栏原来的上限是一个写死的常量（480），它不管窗口多宽、侧栏多宽，
   于是「窗口窄 + 右栏拖到底」时中栏会被压到几乎为零。

   这里把上限改成「窗口的实际余量」：
       上限 = 窗口宽 − 侧栏宽 − 中栏保底宽（LAYOUT.centerReserve）
   窗口越宽、右栏能拖得越宽；窗口变窄时上限自动跟着收。

   ★ 为什么是纯函数：这样它可以被单测直接钉住（不依赖 DOM / window）。
     真正的订阅在 `hooks/useWindowWidth.ts`，施加在 `RightPanelHost`。
   ══════════════════════════════════════════════════════════════ */

export interface RightPanelMaxInput {
  /** 窗口内宽（CSS px）——即 `window.innerWidth` */
  windowWidth: number
  /** 侧栏当前显示宽度（CSS px，折叠时是 collapsed 值） */
  sidebarWidth: number
  /** 中栏保底宽度（CSS px）—— `LAYOUT.centerReserve` */
  reserve: number
  /** 右栏的下限（显示口径）——窗口再窄也不该比它更小 */
  minShown: number
}

/**
 * 右栏能拖到的最宽显示宽度（CSS px）。
 *
 * 窗口宽拿不到（非浏览器 / 异常值）时**保守返回 minShown** ——
 * 宁可右栏停在最小值，也不要因为一个坏值把中栏撑没。
 */
export function rightPanelMaxShown({
  windowWidth,
  sidebarWidth,
  reserve,
  minShown,
}: RightPanelMaxInput): number {
  const win = Number(windowWidth)
  const sidebar = Number(sidebarWidth) || 0
  const keep = Number(reserve) || 0
  const floorValue = Number(minShown) || 0

  if (!Number.isFinite(win) || win <= 0) return floorValue

  const room = win - sidebar - keep
  return Math.max(floorValue, Math.floor(room))
}
