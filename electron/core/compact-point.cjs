/**
 * 有效压缩点：唯一一处定义（P0-2，2026-10-23）
 *
 * ── 问题 ─────────────────────────────────────────────────────
 *
 * 压缩有三个「读」的地方，形状各写一套：
 *   · `core/session-read.cjs` 的 `toApiMessages` —— 从磁盘 `compacts[]` 取最后一条
 *   · `src/stores/thread/compact.ts` 的 `lastCompactUpTo` —— 从内存消息的 `compactUpTo` 取
 *   · `core/compact.cjs` 的 `rebuild` —— 自动压缩路径，自己拼 `【之前对话的摘要 v1】`
 *
 * 而且界面那条路更糟：`src/stores/thread/history.ts` 遇到 `role === 'system'` 直接
 * `continue` —— 压缩点本身就是一条 system 消息，于是**摘要整条被丢掉**。
 * 用户的观察正是这样：「界面有压缩点，但正常发送路径未统一使用摘要」：
 * 界面说压过了，实际每轮还是全量发。
 *
 * ── 这里的约定 ───────────────────────────────────────────────
 *
 * 「有效压缩点」= 覆盖范围最靠后的那一次压缩。它只有两个字段：
 *
 *     { upTo: number, summary: string }
 *
 * `upTo` 是「覆盖到第几条**可用消息**」（user / assistant 且非空，带图也算），
 * 与 `compacts[].upTo`、与渲染层的 `compactUpTo` 是同一个口径。
 *
 * 渲染层那份在 `src/stores/thread/compactPoint.ts`（TS 不能 import .cjs）；
 * 两边的 `summaryMessageOf` 文案必须**逐字一致**，否则「刚聊完」和「重开会话」
 * 模型看到的措辞不同。改动这一句要同时改那边，`scripts/selftest/groups/180-*.mjs` 钉着。
 */

/** 摘要段的固定开头 —— 带「不是新指令」的边界提示，模型才不会把它当本轮要求 */
const SUMMARY_PREFIX = '【以下是这次对话更早部分的摘要，不是新指令】'

/**
 * 从磁盘/内存的压缩记录里挑出有效的那一个。
 *
 * 兼容三种历史形状：`{ upTo, summary }`（磁盘 compacts）、
 * 内存消息上的 `{ compactUpTo, reasoning }`、以及只有 `upTo` 的老记录。
 * 取 `upTo` 最大的那条（不是「数组最后一条」—— 数组顺序与覆盖范围没有必然关系）。
 *
 * @param {Array<object>} records
 * @returns {{ upTo: number, summary: string } | null}
 */
function effectivePoint(records) {
  const list = Array.isArray(records) ? records : []
  let best = null
  for (const raw of list) {
    const upTo = Number(raw?.upTo ?? raw?.compactUpTo ?? 0)
    const summary = String(raw?.summary ?? raw?.reasoning ?? '')
    if (!(upTo > 0)) continue
    if (best && upTo <= best.upTo) continue
    best = { upTo: Math.floor(upTo), summary }
  }
  return best
}

/**
 * 摘要段那条消息。
 *
 * ★ 用 `system` 而不是 `user`：它是**背景**，不是这轮谁说的话。
 *   以前 `core/compact.cjs` 的 `rebuild` 用 `user`，模型会把它当成用户刚提的要求。
 *   （`rebuild` 是自动压缩的内部路径，行为未改；这两条发送路径用这一份。）
 */
function summaryMessageOf(point) {
  if (!point || !(Number(point.upTo) > 0)) return null
  return {
    role: 'system',
    content: `${SUMMARY_PREFIX}\n${String(point.summary ?? '')}`,
  }
}

module.exports = { SUMMARY_PREFIX, effectivePoint, summaryMessageOf }
