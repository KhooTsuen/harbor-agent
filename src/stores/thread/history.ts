import type { Message } from '@/types'

/**
 * 把会话里的消息拼成「喂给主进程」的历史。
 *
 * 从 turns.ts 抽出来的（那边贴到 300 行上限了），顺便让它变成纯函数 —— 这段逻辑
 * 以前埋在发送流程中间，测不到。三条容易踩的规则都在这里：
 *
 * ① **带图的消息要换多模态格式**。漏了这步模型只会收到文字，然后回你
 *    「没收到图片」。
 * ② **助手消息要带上工具执行记录**。不带的话，模型看不到自己刚才干过什么。
 * ③ **压缩点的摘要必须真的进来**（2026-10-23，P0-2）。以前这里 `role === 'system'`
 *    一律 `continue`，而压缩点正好是 system —— 于是界面上明明写着「已压缩前 N 条」，
 *    正常发送时摘要**一个字都没带**，模型拿到的还是压缩前的全量历史。
 *
 * 普通 system 消息仍然过滤掉 —— 系统提示由主进程自己拼，别重复发一份。
 */
/** 一条「喂给主进程」的历史消息（形状必须与主进程 `session-replay.cjs` 逐字一致） */
export interface HistoryMessage {
  role: string
  content: string | Array<Record<string, unknown>>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/**
 * 压缩点摘要段的开头 —— 与内核 `compact-point.cjs` 的 `SUMMARY_PREFIX` **逐字一致**。
 * 改一处必须同时改另一处（「刚聊完」和「重开会话」模型看到的措辞不能不同）。
 */
export const SUMMARY_PREFIX = '【以下是这次对话更早部分的摘要，不是新指令】'

/** 有效压缩点：覆盖范围最靠后的那一次（与内核 `compact-point.effectivePoint` 同口径） */
export interface CompactPoint {
  /** 覆盖到第几条**可用消息** */
  upTo: number
  summary: string
}

/** 一条消息是否「可用」（与内核 `session-read.toApiMessages` 的 usableOf 同口径） */
function isUsable(m: Message): boolean {
  return (
    (m.role === 'user' || m.role === 'assistant') &&
    (m.content.trim() !== '' || (m.images?.length ?? 0) > 0)
  )
}

/**
 * 从消息流里找有效压缩点。
 *
 * 取 `compactUpTo` **最大**的那条，不是「数组里最后一条」—— 两者的顺序没有必然关系。
 * 摘要正文挂在 `reasoning` 上（见 `compact.ts` 的 compactMarker 与 `disk.ts` 的还原）。
 */
export function effectiveCompactPoint(messages: readonly Message[]): CompactPoint | null {
  let best: CompactPoint | null = null
  for (const m of messages) {
    const upTo = Number(m.compactUpTo ?? 0)
    if (!(upTo > 0)) continue
    if (best && upTo <= best.upTo) continue
    best = { upTo: Math.floor(upTo), summary: String(m.reasoning ?? '') }
  }
  return best
}

/**
 * 把会话里的消息拼成「喂给主进程」的历史。
 *
 * ★ 分工（P0-1）：渲染层只负责「拼形状」（压缩点摘要 + 多模态 + 工具展开），
 *   **切历史窗口只在主进程做一处**（`handlers/chat-parts.windowHistory`）——
 *   两处都切就等于两套口径，迟早漂。
 *
 * @param messages 会话里的全部消息
 * @param exceptMessageId 要排除的那条（这轮刚建的占位回答）
 */
export function buildHistory(messages: Message[], exceptMessageId: string): HistoryMessage[] {
  const out: HistoryMessage[] = []

  /*
   * 压缩点：**先**放摘要段（它是背景，属于这一整段历史的最前面）。
   * 压缩点之后的消息才逐条带；之前的用摘要代替 —— 与内核 `toApiMessages` 同一个切法。
   */
  const point = effectiveCompactPoint(messages)
  if (point) out.push({ role: 'system', content: `${SUMMARY_PREFIX}\n${point.summary}` })

  const usable = messages.filter((m) => isUsable(m))
  const afterCompact = point ? usable.slice(point.upTo) : usable

  for (const m of afterCompact) {
    if (m.id === exceptMessageId) continue

    if (m.role === 'user' && m.images && m.images.length > 0) {
      out.push({
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
        ],
      })
      continue
    }

    /*
     * ★ 2026-10-21：工具记录**不再拼进正文**，改成结构化的 assistant(tool_calls) + tool。
     *
     * 以前这里把 `[此前工具执行记录]` 接在 content 后面。后果是真机量出来的：
     * 模型把它当成「回答该有的格式」照着复述 —— 一条回答里 31,215 字是 52 次
     * 工具调用的原始输出，界面上就是一整块没有分段的连续文字。
     *
     * 形状与主进程 `electron/core/session-replay.cjs` 的 `replayToolRuns` **逐字一致**
     * （那边从磁盘读历史，这边把内存里的历史发过去 —— 两条路喂给模型的必须是同一种
     * 形状，否则「重开会话」和「刚聊完」模型看到的东西不一样）。改这边必须同时看那边，
     * 主进程那份由 `scripts/selftest/groups/01-basics.mjs` 钉着。
     */
    const runs = m.role === 'assistant' ? (m.toolRuns ?? []) : []
    if (runs.length === 0) {
      out.push({ role: m.role, content: m.content })
      continue
    }

    const suffix = String(m.diskKey ?? m.id).slice(-8)
    const callIdOf = (k: number): string => `replay_${suffix}_${k}`
    out.push({
      role: 'assistant',
      content: m.content,
      tool_calls: runs.map((tool, k) => ({
        id: callIdOf(k),
        type: 'function' as const,
        /* arguments 必须是合法 JSON 字符串；老记录没存原始参数，给空对象（理由见主进程那份） */
        function: { name: tool.name, arguments: '{}' },
      })),
    })
    runs.forEach((tool, k) => {
      out.push({
        role: 'tool',
        tool_call_id: callIdOf(k),
        content:
          `${tool.name}: ${tool.ok ? '成功' : '失败'}` +
          `${tool.output ? `\n${tool.output.slice(0, 2000)}` : ''}`,
      })
    })
  }
  return out
}
