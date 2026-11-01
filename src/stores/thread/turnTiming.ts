/**
 * 这一轮的用时（2026-10-21）
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────
 *
 * `streamEvents.ts` 贴着 300 行红线，塞不下这段解释；而「用时」的口径是
 * 用户拍板过的（`types/conversation.ts` 的 `Message.durationMs` 注释是唯一真相源），
 * 三处调用都必须走同一条算法，不能各写一份 `Date.now() - x`。
 *
 * ── 起止点 ─────────────────────────────────────────────────
 *
 *   · 起点 = 消息自己的 `timestamp`（按下发送、占位消息建出来的那一刻）
 *   · 终点 = 收到 done / aborted / error 并收尾的那一刻（= 调用本函数的 now）
 *
 * 起点**只从消息上取**，不另记变量：多一份起点就会和消息时间戳漂开，
 * 而「用时」和「消息时间」本来就该同源。
 *
 * 中间**不扣除**等待授权 / 等待澄清的时长 —— 那是用户真实等待的时间，
 * 报「用时 31 秒」时把等他点卡的 5 秒算进去才对得上体感。
 *
 * ── 拿不到就返回 undefined ──────────────────────────────────
 *
 * 老状态、预览环境、时钟回拨（算出来 ≤ 0）一律 `undefined`，字段直接不写。
 * **不兜底推算**：一个编出来的秒数比不显示更糟 —— 用户会当真。
 */

/** 只取算时间所需的那一点形状（不依赖整个 StreamState，方便单测） */
export interface TimingSource {
  timestamp: number
}

/**
 * 从起点算到 `now` 的毫秒数。
 *
 * @param started 起点（消息的 `timestamp`）
 * @param now 终点（默认取当前时刻；单测传固定值）
 * @returns 正数毫秒；起点不合法或算出来 ≤ 0 时返回 `undefined`
 */
export function elapsedSince(started: number, now: number = Date.now()): number | undefined {
  const from = Number(started)
  const to = Number(now)
  if (!Number.isFinite(from) || from <= 0) return undefined
  if (!Number.isFinite(to) || to <= 0) return undefined
  const spent = to - from
  return spent > 0 ? spent : undefined
}

/**
 * 流式状态 → 用时。
 *
 * `snapshot()` 里带着 `timestamp`（`turns.ts` 建占位消息时给的），
 * 这里只做一次转发，把「取哪个字段」收在一处。
 */
export function endedNow(
  state: { snapshot: () => TimingSource },
  now: number = Date.now(),
): number | undefined {
  try {
    return elapsedSince(state.snapshot().timestamp, now)
  } catch {
    return undefined
  }
}
