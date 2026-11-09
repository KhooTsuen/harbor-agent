import type { Message } from '@/types'
import { roundsOf } from '@/components/chat/message/roundsOf'

/* ══════════════════════════════════════════════════════════════
   一条消息的**执行轨迹**：按真实顺序把节点摊平

   ── 为什么需要它（2026-11-09）──────────────────────────────────
   `rounds` 已经能表达「第 1 轮正文 → 第 2 轮工具 → 第 3 轮正文」，
   但没有任何一处**按顺序把它们读出来**：显示是分别取（正文块 + 折叠区）、
   复制只取正文、导出走另一条路。三处各自遍历，顺序对不对没人能一眼验证。

   这里给一个单一入口：`traceNodesOf(message)` → 按发生顺序的节点数组。
   桌面验收、单测、以后要按轨迹渲染的地方，都问它。

   ── 顺序口径（一段不多猜）──────────────────────────────────────
   轮与轮之间：就是 `rounds` 数组顺序（事件到达顺序）。
   轮**内**：`reasoning → content → tools` —— 内核一轮里先产出思考与正文，
   再执行这一轮要调的工；工具结果下一轮才回来。这是数据本身的形状，
   不是从文案里猜的。

   ── ordered 是什么意思 ──────────────────────────────────────────
   `true`  = 这条记录带 `trace: 'ordered-v1'`，`rounds` 是执行时攒的，可信。
   `false` = 老记录：`rounds` 可能是读侧由三段**合成**的一轮（那顺序是猜的），
             或者压根没有 rounds。调用方据此决定「能不能当真实轨迹展示」。
   ══════════════════════════════════════════════════════════════ */

export type TraceNode =
  | { kind: 'reasoning'; round: number; text: string }
  | { kind: 'body'; round: number; text: string }
  | { kind: 'tool'; round: number; id: string; name: string; ok: boolean; pending: boolean }

export interface TraceView {
  /** 这份顺序是否来自执行时的真实事件（false = 老记录 / 读侧合成） */
  ordered: boolean
  nodes: TraceNode[]
}

export function traceNodesOf(message: Message): TraceView {
  const ordered = message.trace === 'ordered-v1'

  /* 用户 / 系统消息没有「执行轨迹」，只有一句话 */
  if (message.role !== 'assistant') {
    const text = String(message.content ?? '')
    return { ordered, nodes: text.trim() ? [{ kind: 'body', round: 0, text }] : [] }
  }

  const rounds = roundsOf(message)
  const runs = message.toolRuns ?? []
  const nodes: TraceNode[] = []

  rounds.forEach((round, index) => {
    if (round.reasoning.trim())
      nodes.push({ kind: 'reasoning', round: index, text: round.reasoning })
    if (round.content.trim()) nodes.push({ kind: 'body', round: index, text: round.content })
    for (const at of round.tools) {
      const run = runs[at]
      /* 下标越界（落盘/读回版本不一致）就跳过，不编一条假的出来 */
      if (!run) continue
      nodes.push({
        kind: 'tool',
        round: index,
        id: run.id,
        name: run.name,
        ok: run.ok,
        pending: run.pending === true,
      })
    }
  })

  return { ordered, nodes }
}

/**
 * 轨迹形状签名：`body>tool>body` 这样的串。
 *
 * 用来做「重启前后是不是同一条轨迹」的逐项对比 —— 比整段比字符串更能定位
 * 「差在哪一步」（正文顺序变了 / 少了一次工具 / 多了一轮）。
 */
export function traceSignatureOf(message: Message): string {
  const view = traceNodesOf(message)
  return view.nodes
    .map((node) =>
      node.kind === 'tool'
        ? node.pending
          ? 'tool?'
          : 'tool'
        : node.kind === 'body'
          ? 'body'
          : 'think',
    )
    .join('>')
}
