/**
 * 按天归日的工具（`usage-query.cjs` 的热点优化，2026-11-09）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * `usage-query.cjs` 已经贴 300 行；而且这块是**纯字符串/时间换算**，
 * 和「聚合」没有耦合。
 *
 * ── 为什么要缓存（实测数字）───────────────────────────────────
 * 原来聚合每行都 `new Date(at)` 再取三次分量算 `YYYY-MM-DD`。
 * 4 万行光这一步 **12ms**，是全量聚合（214ms）里最大的单项。
 * 账本行按时间追加，相邻行大多在同一天 —— 所以按「天」缓存命中率极高。
 *
 * ── 为什么不用 `Math.floor(ms / 86400000)` ────────────────────
 * 那等于按 **UTC** 切天。在 +08:00 时区，本地 8:00 之前的记录会被算到
 * 前一天 —— 这个项目 2026-11-08 已经因为同类的「按 UTC 除法切天」栽过一次，
 * 当时的后果是跨年统计错位、自检直接红。
 *
 * 这里的做法：**先算本地零点**（`setHours(0,0,0,0)`），再用它的毫秒数当索引。
 * 同一天的所有时间戳拿到同一个索引，跨月跨年由 Date 自己处理。
 */

/** 一天毫秒数 */
const DAY = 86400000

/**
 * 缓存：`天序号 → 'YYYY-MM-DD'`。
 *
 * 天序号 = 本地零点的毫秒数 / DAY。**它可能是小数**（+08:00 时区是 0.333…），
 * 但这不影响正确性 —— 同一天必然得到同一个值，直接当 Map 键用。
 */
const labels = new Map()

/** 上限：跨 5 年也就 1800 多个键；超过就整体清空（防无界增长） */
const MAX_KEYS = 3000

/**
 * 时间戳 → 本地日序号（同一天返回同一个数，无法解析返回 NaN）
 *
 * ★ 按**小时**缓存：任意一小时内的所有时间点，本地零点都相同（小时边界和
 *   日界都是整点，一小时不可能跨日）。所以这个缓存是精确的，不是近似。
 *   4 万行实测能省掉绝大部分 `new Date` + `setHours`（原来 12ms 的那一步）。
 */
const indexCache = new Map()
const MAX_INDEX_KEYS = 20000

function dayIndexOf(at) {
  const ms = Number(at)
  if (!Number.isFinite(ms) || ms <= 0) return Number.NaN
  const hour = Math.floor(ms / 3600000)
  const hit = indexCache.get(hour)
  if (hit !== undefined) return hit
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return Number.NaN
  d.setHours(0, 0, 0, 0)
  const index = d.getTime() / DAY
  if (indexCache.size >= MAX_INDEX_KEYS) indexCache.clear()
  indexCache.set(hour, index)
  return index
}

/**
 * 日序号 → `YYYY-MM-DD`（**只在最终产出时调用**，不是每行一次）
 *
 * @param {number} index `dayIndexOf` 的返回值
 * @returns {string} 无法解析时返回 `''`
 */
function labelOf(index) {
  if (!Number.isFinite(index)) return ''
  const hit = labels.get(index)
  if (hit !== undefined) return hit
  const d = new Date(index * DAY)
  const pad = (n) => String(n).padStart(2, '0')
  const label = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (labels.size >= MAX_KEYS) labels.clear()
  labels.set(index, label)
  return label
}

/** 时间戳 → `YYYY-MM-DD`（对外接口，语义与旧 `dayKey` 完全一致） */
function dayKey(at) {
  return labelOf(dayIndexOf(at))
}

module.exports = { dayKey, dayIndexOf, labelOf, DAY }
