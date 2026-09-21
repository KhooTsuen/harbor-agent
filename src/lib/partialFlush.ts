/**
 * 流式回复的**分段落盘**节奏
 *
 * 为什么需要这件事：助手那条消息只在 `done` / `aborted` 时落盘，而进程被强杀 /
 * 崩溃时这两个事件都不会来 —— 于是**半截回复全丢**（实测：会话文件里只剩用户那句，
 * 助手那条一行都没有）。
 *
 * 但也不能每个 token 都写一次：会话文件是**追加式 JSONL**，每次都要写整段内容，
 * 写得越勤总写入量越大（n 次追加 × 平均半篇 ≈ n²）。所以规则是：
 *
 *   · 至少隔 3 秒（别把磁盘和 IPC 打满）
 *   · 且比上次多长了「200 字」或「当前长度的 10%」（取大的那个）
 *
 * 「10%」那一条是关键：它让追加次数随长度**对数增长**（而不是线性），
 * 总写入量约等于最终内容的十几倍封顶，同时任何时刻最新那条快照离「现在」
 * 最多也就差 10% 的内容。
 *
 * 抽成纯函数是为了能直接测 —— 时间与长度都从参数进来，不读 Date.now()。
 */

/** 两次落盘之间至少隔这么久 */
export const PARTIAL_MIN_MS = 3000
/**
 * 内容至少长这么多才值得多写一行。
 *
 * 定小了会刷盘吗：不会 —— **时间间隔**（上面那条）才是防刷盘的主力。
 * 定大了反而漏：一开始写的是 200 字，于是**短回答永远不会留下快照**，
 * 而「写到一半进程被打断」恰恰是短回答也会遇到的。
 *
 * 结合下面的 10% 规则，实际效果是两段：
 *   · 300 字以内：每长 30 字写一次（算术增长）
 *   · 超过 300 字：每长「当前的 10%」写一次（几何增长）
 * 所以一段长回复的总追加量约是最终内容的十几倍，不会随长度爆掉。
 */
export const PARTIAL_MIN_GROWTH = 30
/** 「当前长度的 10%」这个比例 */
export const PARTIAL_GROWTH_RATIO = 0.1

/**
 * 这一轮该不该落盘。
 *
 * @param length 当前内容长度
 * @param lastLength 上次落盘时的长度（没落过传 0）
 * @param now 现在（毫秒）
 * @param lastAt 上次落盘时刻（没落过传 0）
 */
export function shouldFlushPartial(
  length: number,
  lastLength: number,
  now: number,
  lastAt: number,
): boolean {
  if (!Number.isFinite(length) || length <= 0) return false
  if (lastAt > 0 && now - lastAt < PARTIAL_MIN_MS) return false
  const grew = length - Math.max(0, lastLength)
  return grew >= Math.max(PARTIAL_MIN_GROWTH, Math.floor(length * PARTIAL_GROWTH_RATIO))
}
