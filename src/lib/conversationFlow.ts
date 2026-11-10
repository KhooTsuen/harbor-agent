import { z } from 'zod'
import { settleCollaboration } from './collaborationSettlement'

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
  /**
   * 上层**明确**说了这段属于答复（`content` 事件带 `stage: 'answer'`）。
   *
   * 有了它，后面再调工具也**不降级** —— 任务口径：「已明确属于答复的片段，
   * 即使后面又调用工具，也保留答复归属」。
   *
   * ★ 为什么不能拿 `purpose === 'answer'` 当这个判据：新建的普通文字默认也是
   *   `answer`（乐观），那样就等于谁都不降级，过程话又会被当成答复。
   *   必须区分「默认值」和「明确信号」。
   */
  hold: z.boolean().optional(),
  /**
   * 上游自带的正文段身份（第 2 项）。可选 —— HTTP/SSE 那条路本来就没有消息 id。
   * 存下来是为了重启回放时仍按**上游身份**分段，而不是重新按内容猜。
   */
  segId: z.string().optional(),
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

/**
 * 把某一轮里还标 `answer` 的片段改成别的用途。
 *
 * **两种不夺回**：
 *   · `purpose === 'final'` —— 已经结算过的正式答复
 *   · `hold === true` —— 上层明确说过「这段是答复」（后面再干活也留着）
 */
function retag(nodes: readonly FlowNode[], turn: number, to: SpeechPurpose): FlowNode[] {
  return nodes.map((node) =>
    node.kind === 'speech' &&
    node.turn === turn &&
    purposeOf(node) === 'answer' &&
    node.hold !== true
      ? { ...node, purpose: to }
      : node,
  )
}

function unconfirmed(nodes: readonly FlowNode[]): FlowNode[] {
  return nodes.map((node) =>
    node.kind === 'speech' && purposeOf(node) === 'answer'
      ? { ...node, purpose: 'unconfirmed' }
      : node,
  )
}

/**
 * 还没结算的正文片段（`answer` / `unconfirmed` / `final`，不含过程话）。
 *
 * ★ 为什么集中到一处：显示、复制、导出、阅读导航都要回答「哪几段还算正文」。
 *   各入口自己写一份判据一定漂 —— `bodyText.ts` 文件头记的就是这类事故
 *   （复制和界面取数走了两条路）。这里只声明「哪些片段有资格当正文」，
 *   不做任何拼接决策。
 */
export function pendingSpeechesOf(flow: ConversationFlow): string[] {
  return flow.nodes.flatMap((node) =>
    node.kind === 'speech' && purposeOf(node) !== 'chatter' && node.text.trim() ? [node.text] : [],
  )
}

/**
 * 明确信号固定的片段归入同一份终稿；汇总已包含的片段不重复追加。
 *
 * 只有**确实进了交付正文**的片段才标 `final`；其余归 `chatter`（已被取代的过程材料，
 * 收进折叠区，原文与顺序都在）。为什么不标 `unconfirmed`：那个专指「真拿不准」
 * （中断 / 暂停 / 截断 / 干过活却没交付），这里已经拿到了交付正文，属「确定被取代」。
 * 只动还标 `answer` 的片段 —— `chatter` / `unconfirmed` / `final` 都是已有结论，
 * 结算不该回头改写（早先的写法会把过程话重新标成未确认，导出里整段变空）。
 * 边界：单模型普通正文没有阶段信号，「补充」与「更正」上游长得一样，
 * 能确定的只有「是否被终稿文本吸收」与带 `hold` 的片段，不靠相似度猜。
 */
function settle(flow: ConversationFlow, text: string): ConversationFlow {
  const absorbed = (node: FlowNode): boolean =>
    node.kind === 'speech' && Boolean(node.text.trim()) && text.includes(node.text)
  const prefix = flow.nodes.flatMap((node) =>
    node.kind === 'speech' &&
    node.hold &&
    purposeOf(node) !== 'final' &&
    node.text.trim() &&
    !absorbed(node)
      ? [node.text]
      : [],
  )
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.kind !== 'speech') return node
      /* 已有结论的片段（final / chatter / unconfirmed）不再被结算回头改写 */
      if (purposeOf(node) !== 'answer') return node
      /* 更早轮次又没被明确钉住的片段，状态由 `retag` 负责，这里不动 */
      if (node.turn !== flow.turn && node.hold !== true) return node
      return absorbed(node) || prefix.includes(node.text)
        ? { ...node, purpose: 'final' }
        : { ...node, purpose: 'chatter' }
    }),
    final: [...prefix, text].join('\n\n'),
  }
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

  if (type === 'aborted' || type === 'error') {
    return { ...flow, nodes: unconfirmed(nodes) }
  }

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
    const purpose: SpeechPurpose = event.stage === 'process' ? 'chatter' : 'answer'
    const last = nodes.at(-1)
    /* 同一轮同类型的连续片段并成一段（上游是一批一批给的） */
    const samePurpose =
      last?.kind !== 'speech' ||
      (purposeOf(last) === purpose && Boolean(last.hold) === (event.stage === 'answer'))
    /*
     * ★ 2026-11-11（第 2 项）：上游给了段身份时**按身份分段**，不靠「挨着就并」。
     *
     * 判据只有一条：两边都有 segId 且**不同** → 新起一段。缺失时保持原行为
     * （HTTP/SSE 那条路本来就没有消息 id，不能因此把每段都切开）。
     * 这里**不比较文本相似度**，也不拿位置编号冒充身份。
     */
    const seg = typeof event.segId === 'string' && event.segId ? event.segId : ''
    const lastSeg = last && last.kind === 'speech' ? (last.segId ?? '') : ''
    const sameSegment = !seg || !lastSeg || seg === lastSeg
    if (last?.kind === kind && last.turn === turn && samePurpose && sameSegment) {
      return { ...flow, nodes: [...nodes.slice(0, -1), { ...last, text: last.text + event.text }] }
    }
    return {
      ...flow,
      nodes: [
        ...nodes,
        kind === 'speech'
          ? {
              kind,
              id,
              turn,
              text: event.text,
              purpose,
              /* 上游给的段身份原样留（没有就不写这个键） */
              ...(seg ? { segId: seg } : {}),
              /* 上层明确给了「这是答复」的信号 → 钉住，后面调工具也不降级 */
              ...(event.stage === 'answer' ? { hold: true } : {}),
            }
          : { kind, id, turn, text: event.text },
      ],
    }
  }

  if (type === 'done') {
    const delivered = settleCollaboration(flow, event)
    if (delivered) return delivered
    /*
     * 暂停 / 轮数用尽 / 截断 → **不结算**。这段文字算不算答复，现在不知道 ——
     * 标 `unconfirmed`，界面如实说「还没确认」，不许冒充成正式答复。
     */
    if (event.exhausted || event.paused || event.truncated) {
      return { ...flow, nodes: unconfirmed(nodes) }
    }
    const text = typeof event.finalContent === 'string' ? event.finalContent : ''
    /*
     * 有正式答复 → 结算。这一轮还标 `answer` 的片段被它吸收（标 `final`，渲染不再单独出），
     * `chatter`（过程话）原样留在折叠区。
     */
    if (text.trim()) return settle(flow, text)
    /*
     * 没有交付正文，只剩 Provider 的「这轮说完了」（`finish_reason: stop`）。
     *
     * ★ `stop` 只证明**模型停止生成**，不证明它给出了交付物 —— 2026-11-09 实测：
     *   模型说一句「我接下来会跑测试」然后 stop，没有测试结果。
     *   那段话在工具开始时已被降级成 `chatter`，旧实现却会在这里
     *   `find(kind === 'speech')` 把它**再捞回来**标成 `final`（既不按轮次过滤，
     *   也不看这一轮到底干没干活）—— 等于把一句计划话当成了已确认的正式交付。
     *
     * 所以只有**一次工具都没调过**（纯聊天）才用 stop 结算：
     * 那种情况「最后一段话」本来就是回答本身，且没有别的东西能当答复。
     * 干过活却没有交付正文 → 标 `unconfirmed`，界面如实说「还没结算」。
     */
    if (event.finishReason === 'stop') {
      const worked = nodes.some((node) => node.kind === 'tool')
      if (worked) return { ...flow, nodes: unconfirmed(nodes) }
      const lastSpeech = [...nodes]
        .reverse()
        .find(
          (node) => node.kind === 'speech' && node.turn === turn && purposeOf(node) === 'answer',
        )
      if (!lastSpeech) return flow
      return lastSpeech.kind === 'speech' ? settle(flow, lastSpeech.text) : flow
    }
    return flow
  }

  return flow
}
