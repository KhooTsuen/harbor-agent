/* ══════════════════════════════════════════════════════════════
   夜航彩蛋（设计文档 §13.3 / §14）

   连点左上角品牌标 5 次 → 解锁「夜航」主题；再连点 5 次切回默认。
   「2 秒窗口内 5 次」的规则保证日常操作不会误触。

   这里只有**纯逻辑**（可注入时钟，单测不碰真实时间）；
   切换主题 / 弹 toast 的副作用在 AppTitleBar 里做。
   ══════════════════════════════════════════════════════════════ */

export const CLICK_WINDOW_MS = 2000
export const CLICKS_NEEDED = 5

export interface BrandClickState {
  /** 时间窗口内的点击时刻（ms） */
  at: number[]
}

export function createBrandClickState(): BrandClickState {
  return { at: [] }
}

/**
 * 记一次点击。返回下一状态 + 这次是否触发。
 * 触发后计数清零 —— 继续再点满 5 次算下一轮（用来切回默认）。
 */
export function registerBrandClick(
  state: BrandClickState,
  now: number,
): { state: BrandClickState; fired: boolean } {
  const kept = state.at.filter((t) => now - t < CLICK_WINDOW_MS)
  kept.push(now)
  if (kept.length >= CLICKS_NEEDED) return { state: { at: [] }, fired: true }
  return { state: { at: kept }, fired: false }
}
