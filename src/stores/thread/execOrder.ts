import type { ChatEvent } from '@/types/chat-events'

/* ══════════════════════════════════════════════════════════════
   事件序号守卫（2026-11-09 · 真实执行顺序）

   ── 它解决什么 ────────────────────────────────────────────────
   主进程从 2026-11-09 起给每条 `chat:event` 带 `seq`（本执行内从 1 递增，
   见 `electron/core/chat-emit.cjs`）。渲染层此前只有「到达顺序」这一个依据 ——
   IPC 保序时它是对的，但**没法证明它对**：正文是 20 条/秒攒批发的，工具 /
   重试 / 结束这类结构事件是立刻发的，两者交错时一旦 flush 时机出问题，
   界面上就是「先看到结论、后看到过程」，而且事后无从追查。

   有了 seq 就能做到「至少不再静默接受乱序」：小于上次的序号记一笔，
   报告里能直接说「这一轮出现过 N 条乱序」。

   ── 为什么状态按 requestId 自己管 ──────────────────────────────
   调用方 `turns.ts` 已经 298 行贴着红线。它只需在事件回调里喊一声
   `touchOrder(event)`，建档 / 取值 / 清理全在这里做，调用方不用持有状态。

   ── 向后兼容 ──────────────────────────────────────────────────
   老版本主进程不发 seq（`undefined`）→ 一律当「没有序号」，不告警、不改行为。
   ══════════════════════════════════════════════════════════════ */

interface Order {
  /** 已见过的最大序号（0 = 还没见过带序号的） */
  last: number
  /** 累计出现几次回退（诊断用） */
  outOfOrder: number
}

/** 按 requestId 记「这一轮看到哪了」。只留最近若干个 —— 长会话开一晚上不会涨。 */
const orders = new Map<string, Order>()
const MAX_KEPT = 32

function orderOf(requestId: string): Order {
  let one = orders.get(requestId)
  if (one) return one
  one = { last: 0, outOfOrder: 0 }
  orders.set(requestId, one)
  /* 超上限就丢最早那条（Map 保持插入序）—— 它早已结束，没人再来问 */
  while (orders.size > MAX_KEPT) {
    const first = orders.keys().next().value
    if (first === undefined) break
    orders.delete(first)
  }
  return one
}

/** 一条事件的序号。0 / 负数 / NaN / 缺失一律视为「没有序号」，不拿它污染 last */
function seqNumberOf(event: Record<string, unknown>): number {
  const n = Number(event.seq)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 记一条事件的序号（**每次事件都要调**，非序号事件传进来是空操作）。
 *
 * 终态事件（done / aborted / error）处理完就顺手把这条记录删掉 —— 调用方
 * 不用再记得清理，长会话开一晚上也不会积。
 *
 * @returns `ok` 正常前进 / `out-of-order` 比上次小 / `no-seq` 老主进程或不带序号
 */
export function touchOrder(
  event: ChatEvent | Record<string, unknown>,
): 'ok' | 'out-of-order' | 'no-seq' {
  const raw = event as Record<string, unknown>
  const seq = seqNumberOf(raw)
  const requestId = String(raw.requestId ?? '')
  const terminal = /^(done|aborted|error)$/.test(String(raw.type ?? ''))
  if (seq === 0 || !requestId) return 'no-seq'
  const one = orderOf(requestId)
  if (seq < one.last) {
    one.outOfOrder += 1
    return 'out-of-order'
  }
  one.last = seq
  /* 这一轮收了尾，序号水位没人再来问 —— 删掉（同一 requestId 不会再发事件） */
  if (terminal) orders.delete(requestId)
  return 'ok'
}

/** 这一轮出现过几次乱序（诊断 / 报告用；没跑过就是 0） */
export function outOfOrderCount(requestId: string): number {
  return orders.get(requestId)?.outOfOrder ?? 0
}

/** 一轮结束就清掉它，别让 Map 一直挂着（`turns.ts` 收尾时调一次） */
export function forgetOrder(requestId: string): void {
  orders.delete(requestId)
}
