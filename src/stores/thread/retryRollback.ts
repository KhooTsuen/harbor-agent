import type { MessageRound } from '@/types'

/**
 * 重试时把「这一次尝试已经流出去的字」退回去（2026-10-21，用户真机报的「回答显示两遍」）
 *
 * ── 为什么必须有这一步 ────────────────────────────────────────────
 *
 * 上游报可重试的错（限流 / 超时 / 服务器错）时 `loop-model.cjs` 会**从头重新请求整段**
 * （`:148-152`），而渲染层只把新分片往后追加 —— 于是这一轮变成「上次的半截 + 这次的
 * 整段」，屏幕上同一段话出现两遍。用户截图里的形状正是这样：第一段断在句子中间
 * （「就告诉我哪一块没变」），第二段从中间那句话开始把全文再说一遍。
 *
 * ── 这条约定不是新造的 ─────────────────────────────────────────
 *
 * `electron/core/ext-chat-streams.cjs:132-139` 给扩展侧边栏的那份快照**早就这么做了**
 * （`snap.text.slice(0, snap.roundText)`），那里注释写的也是同一句「否则重试后模型
 * 再说一遍，这一轮就是两遍」。只有渲染层这条主链路漏了 —— 同一约定两套写法
 * （AGENT.md 第 9 条那个坑）。改这里时请顺手看那一边，别让它们再分叉。
 *
 * ── 只退到「本轮起点」──────────────────────────────────────────
 *
 * 一轮 agent 循环里会调多次模型，每次 `turn_start` 就是新的一段。退到**本轮起点**
 * 而不是清空：前面几轮说过的话是有效的，不能被这次重试一起抹掉。
 * 正文与思考各记一个长度 —— 两者的累积量不同，不能共用一个数（同 ext-chat-streams）。
 *
 * ★ 同时记下「本轮在 `rounds` 里的下标」：光有全局长度不够 —— `rounds[i].content`
 *   是**增量**（只有本轮说的字），用它去截全局长度会算错。记下标 + 那轮当时的长度，
 *   两个视角各退各的，才不会把上一轮的字截掉。
 */

/** 本轮开始时「已经说到哪」（正文 / 思考各一份，全局与 rounds 两个视角） */
export interface RetryMarks {
  /** 全局累积正文长度（= `StreamState.content`） */
  text: number
  /** 全局累积思考长度（= `StreamState.reasoning`） */
  think: number
  /** 本轮在 `rounds` 里的下标（-1 = 还没有任何一轮） */
  round: number
  /** 那轮当时的正文长度 */
  roundText: number
  /** 那轮当时的思考长度 */
  roundThink: number
}

/** 保留前 n 个字（n 越界时按内容长度夹住，绝不清成负数） */
function keep(text: string, n: number): string {
  const value = String(text ?? '')
  return value.slice(0, Math.min(Math.max(0, n), value.length))
}

/**
 * 记下本轮起点。
 *
 * @param content   全局累积正文
 * @param reasoning 全局累积思考
 * @param rounds    当前轮次表（取最后一轮作为「本轮」）
 */
export function markRoundStart(
  content: string,
  reasoning: string,
  rounds: readonly MessageRound[],
): RetryMarks {
  const last = rounds[rounds.length - 1]
  return {
    text: String(content ?? '').length,
    think: String(reasoning ?? '').length,
    round: rounds.length - 1,
    roundText: String(last?.content ?? '').length,
    roundThink: String(last?.reasoning ?? '').length,
  }
}

/**
 * 退回本轮起点。
 *
 * `changed: false` = 一个字都没退（本来就没有半截要丢）—— 调用方别写字段，
 * 省一次无谓的重渲。
 */
export function rollbackToRoundStart(
  content: string,
  reasoning: string,
  rounds: readonly MessageRound[],
  marks: RetryMarks,
): { content: string; reasoning: string; rounds: MessageRound[]; changed: boolean } {
  const nextText = keep(content, marks.text)
  const nextThink = keep(reasoning, marks.think)

  let roundsChanged = false
  const nextRounds = rounds.map((round, index) => {
    if (index !== marks.round) return round
    const roundContent = keep(round.content, marks.roundText)
    const roundReasoning = keep(round.reasoning, marks.roundThink)
    if (roundContent === round.content && roundReasoning === round.reasoning) return round
    roundsChanged = true
    return { ...round, content: roundContent, reasoning: roundReasoning }
  })

  return {
    content: nextText,
    reasoning: nextThink,
    rounds: roundsChanged ? nextRounds : (rounds as MessageRound[]),
    changed:
      roundsChanged || nextText !== String(content ?? '') || nextThink !== String(reasoning ?? ''),
  }
}
