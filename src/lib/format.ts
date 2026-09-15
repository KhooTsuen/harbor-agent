/* ══════════════════════════════════════════════════════════════
   数字格式化

   状态栏和用量页都要显示 token 数，放一处免得两边写法不一致。
   ══════════════════════════════════════════════════════════════ */

/** 完整数字，带千位分隔（给 title / 详情用） */
export function formatCount(value: number): string {
  return Math.round(value || 0).toLocaleString('zh-CN')
}

/** 缩写：1.2k / 3.4M —— 状态栏那种地方位置紧张 */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value || 0))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
