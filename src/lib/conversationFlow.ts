import { z } from 'zod'

/* ══════════════════════════════════════════════════════════════
   原生对话流（v2）：每段文字有稳定身份、明确用途

   ── 为什么要 purpose（第二阶段）──────────────────────────────
   v1 只记 `kind`（speech / reasoning / tool）—— 分得出「这段是文字还是工具」，
   分不出「这段文字在交付里算哪一类」。后果：一句「我先看看这两个文件」和
   最终结论在数据里长得一模一样，只能靠「后面有没有工具」在渲染层猜；
   猜错就把过程话当结论复制出去（用户 2026-11-09 报的那个 bug 的另一半）。

   ── 四态 ──────────────────────────────────────────────────────
     chatter      过程发言：后面又干活了 → 收进折叠区
     answer       答复片段：默认值守；还没结算，随时可能被降级
     final        正式答复：已明确属于交付 —— **后面再干活也不夺回来**
     unconfirmed  暂未确认：中断 / 截断 / 暂停 —— 拿不准，不许冒充答复

   ── 与 v1 的关系（老记录只读兼容）────────────────────────────
   v1 记录读进来**不改写**：`speech` 按 `answer` 看待（乐观），有 `final` 就当已结算。
   写回必须是 v2。判据在 `migrateFlow()`，调用方决定要不要落盘。
   ══════════════════════════════════════════════════════════════ */

export const SPEECH_PURPOSES = ['chatter', 'answer', 'final', 'unconfirmed'] as const
export type SpeechPurpose = (typeof SPEECH_PURPOSES)[number]

const speechSchema = z.object({
  kind: z.literal('speech'),
  id: z.number(),
  turn: z.number(),
  text: z.string(),
  /** v1 记录没有这个字段 → 按 `answer` 看待（见文件头） */
  purpose: z.enum(SPEECH_PURPOSES).optional(),
})

const nodeSchema = z.discriminatedUnion('kind', [
  speechSchema,
  z.object({ kind: z.literal('reasoning'), id: z.number(), turn: z.number(), text: z.string() }),
  z.object({ kind: z.literal('tool'), id: z.number(), turn: z.number(), toolId: z.string() }),
])

/** 当前写入的版本；读侧同时接受 1（老记录） */
export const FLOW_VERSION = 2

export const conversationFlowSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  turn: z.number(),
  nodes: z.array(nodeSchema),
  final: z.string().optional(),
})

export type ConversationFlow = z.infer<typeof conversationFlowSchema>
export type FlowNode = z.infer<typeof nodeSchema>

/** 这段文字在交付里算什么（v1 记录没有 purpose → 乐观当答复片段） */
export function purposeOf(node: FlowNode): SpeechPurpose | '' {
  if (node.kind !== 'speech') return ''
  return node.purpose ?? 'answer'
}

/** 把某一轮里还标 `answer` 的片段改成别的用途 —— **跳过 final**（已明确的不夺回） */
function retag(nodes: readonly FlowNode[], turn: number, to: SpeechPurpose): FlowNode[] {
  return nodes.map((node) =>
    node.kind === 'speech' && node.turn === turn && purposeOf(node) !== 'final'
      ? { ...node, purpose: to }
      : node,
  )
}

/**
 * v1 → v2 的**读时**归一（不写盘）。
 *
 * 只补 `purpose`，不动文本与顺序；`final` 字段照旧。调用方要落盘时自己决定 ——
 * 老记录不改写是硬约束 5 的要求（用户已有真实会话）。
 */
export function migrateFlow(flow: ConversationFlow): ConversationFlow {
  if (flow.version === FLOW_VERSION) return flow
  return {
    ...flow,
    version: FLOW_VERSION,
    nodes: flow.nodes.map((node) =>
      node.kind === 'speech' && !node.purpose ? { ...node, purpose: 'answer' } : node,
    ),
  }
}

export function advanceFlow(
  flow: ConversationFlow,
  event: Record<string, unknown>,
): ConversationFlow {
  const type = event.type
  const { nodes, turn } = flow
  const id = nodes.length

  /* 开新一轮（含模型重试）= 上一轮说的话只是过程 —— 但**已明确的正式答复不夺回** */
  if (type === 'turn_start' || type === 'retry') {
    return { ...flow, turn: turn + 1, nodes: retag(nodes, turn, 'chatter') }
  }

  if (
    (type === 'agent.tool.started' ||
      type === 'agent.tool.completed' ||
      type === 'agent.tool.failed') &&
    typeof event.toolCallId === 'string' &&
    !nodes.some((node) => node.kind === 'tool' && node.toolId === event.toolCallId)
  ) {
    /* 又要干活了 → 这一轮刚才那段是过程发言（final 除外）。降级与插入同一次返回 */
    return {
      ...flow,
      nodes: [
        ...retag(nodes, turn, 'chatter'),
        { kind: 'tool', id, turn, toolId: event.toolCallId },
      ],
    }
  }

  if ((type === 'content' || type === 'reasoning') && typeof event.text === 'string') {
    const kind = type === 'content' ? 'speech' : 'reasoning'
    const last = nodes.at(-1)
    /* 同一轮同类型的连续片段并成一段（上游是一批一批给的） */
    if (last?.kind === kind && last.turn === turn) {
      return { ...flow, nodes: [...nodes.slice(0, -1), { ...last, text: last.text + event.text }] }
    }
    return {
      ...flow,
      nodes: [
        ...nodes,
        kind === 'speech'
          ? { kind, id, turn, text: event.text, purpose: 'answer' as const }
          : { kind, id, turn, text: event.text },
      ],
    }
  }

  if (type === 'done') {
    /*
     * 暂停 / 轮数用尽 / 截断 → **不结算**。这段文字算不算答复，现在不知道 ——
     * 标 `unconfirmed`，界面如实说「还没确认」，不许冒充成正式答复。
     */
    if (event.exhausted || event.paused || event.truncated) {
      return { ...flow, nodes: retag(nodes, turn, 'unconfirmed') }
    }
    const text = typeof event.finalContent === 'string' ? event.finalContent.trim() : ''
    /*
     * 有正式答复 → 结算。这一轮还标 `answer` 的片段被它吸收（标 `final`，渲染不再单独出），
     * `chatter`（过程话）原样留在折叠区。
     */
    if (text) {
      return {
        ...flow,
        nodes: nodes.map((node) =>
          node.kind === 'speech' && node.turn === turn && purposeOf(node) === 'answer'
            ? { ...node, purpose: 'final' as const }
            : node,
        ),
        final: text,
      }
    }
    /*
     * 没有正式答复、但 Provider 明确说了「这轮说完了」（`finish_reason: stop`）→
     * 那这段就是答复，把最后一段 `answer` 认作 `final`。
     * 没有这个信号（空串 = 异常结束 / 老主进程）→ 一个字都不动，留 `answer` 让界面照常显示。
     */
    if (event.finishReason === 'stop') {
      const lastSpeech = [...nodes].reverse().find((node) => node.kind === 'speech')
      if (!lastSpeech) return flow
      return {
        ...flow,
        nodes: nodes.map((node) =>
          node === lastSpeech ? { ...node, purpose: 'final' as const } : node,
        ),
      }
    }
    return flow
  }

  return flow
}
