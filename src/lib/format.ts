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

/**
 * 金额（A-展示 · 折算层）。用内置 `Intl.NumberFormat`，**零新依赖**。
 *
 * 两个刻意的取舍：
 *   · **小额多给两位**：命中缓存的输入价低到「每百万 0.02 元」，一屏几千 token
 *     算出来是 0.0000x 元 —— 两位小数会一律显示 `¥0.00`，看着像「不要钱」。
 *     所以 < 0.01 元时给 4 位小数。
 *   · **货币代码异常不抛**：`currency` 是用户在 config.json 里手填的，
 *     写错（`RMB`、空串、乱码）时不该让整块用量面板白屏。空串回落 CNY；
 *     其余走 `try/catch` 兜底 —— 实测 node 24 对 `RMB` 并不抛（原样印出来），
 *     但**别的 ICU 版本会抛 `RangeError`**，所以这一层要留着，不能靠实测结论删掉。
 */
export function formatMoney(value: number, currency = 'CNY'): string {
  const n = Number(value)
  const safe = Number.isFinite(n) ? n : 0
  const digits = Math.abs(safe) > 0 && Math.abs(safe) < 0.01 ? 4 : 2
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: String(currency || 'CNY'),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(safe)
  } catch {
    return `${safe.toFixed(digits)} ${currency || 'CNY'}`
  }
}
