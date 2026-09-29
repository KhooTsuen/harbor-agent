import type { Message, MessageRound } from '@/types'

/* ══════════════════════════════════════════════════════════════
   这条消息该怎么分段

   新记录自带 `rounds`（内核每一轮都发 `turn_start`，渲染层按事件到达顺序
   记下来）—— 直接用。

   老记录没有（字段是后加的，磁盘上一条都没有）→ **合成一轮**：
   整段思考 → 全部工具 → 正文。

   为什么不再单独留一套「卡片式三段堆叠」：
     · 同一份对话里会出现两种排版（新的时间线 / 老的带边框卡片），接缝一眼可见
     · 卡片那套在窄一点的窗口上又重又占地方 —— 用户 2026-09-30 拿 VS Code 的
       截图对比后说「应该像那样」，指的就是不要大卡片
   合成一轮之后信息**一点没少**（思考、每一步工具、正文都在），只是老的也长成
   新的样子了。
   ══════════════════════════════════════════════════════════════ */

export function roundsOf(message: Message): MessageRound[] {
  if (message.rounds && message.rounds.length > 0) return message.rounds

  const reasoning = message.reasoning ?? ''
  const content = message.content ?? ''
  const runs = message.toolRuns ?? []
  if (!reasoning.trim() && !content.trim() && runs.length === 0) return []

  return [
    {
      reasoning,
      content,
      /* 工具记录本身不重复存，这里存下标 —— 和流式那条路一个口径 */
      tools: runs.map((_, index) => index),
    },
  ]
}

/** 这条消息已经有任何东西可画了吗（刚按下发送时是 false —— 那时要给「在动」的反馈） */
export function hasAnything(rounds: readonly MessageRound[]): boolean {
  return rounds.some(
    (round) =>
      round.reasoning.trim() !== '' || round.content.trim() !== '' || round.tools.length > 0,
  )
}
