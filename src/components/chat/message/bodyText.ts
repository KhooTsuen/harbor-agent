import type { Message } from '@/types'
import { roundsOf } from './roundsOf'
import { isProcessSpeech } from './groupRounds'

/* ══════════════════════════════════════════════════════════════
   「这条消息显示出来的正文」—— 复制与渲染共用这一份

   ── 为什么需要它（2026-11-09 用户报的 bug）──────────────────────

   病：点「复制正文」，剪贴板里的内容与那条消息上看到的正文对不上。

   根因是**取数走了两条路**：

     · 界面：`MessageRounds` 逐轮画 `rounds[i].content`，跳过「过程话」
       （有工具、非末轮 —— 判据在 `groupRounds.isProcessSpeech`）
     · 复制：直接 `message.content`

   `message.content` 只是**最后一轮**的正文。可一条 Agent 消息常常有多轮正文：
   「我先看一下 A」→ 调工具 →「A 没问题，再看 B」→ 调工具 →「结论：……」
   其中「我先看一下 A」这类**没调工具**的轮，按判据算正文，界面上明明白白
   显示着，复制却拿不到。

   所以正确的正文 = **渲染时判定为正文的那些轮**，一段不多、一段不少。
   这里把那套判据原样复用（不另写一份 —— 两份判据迟早漂开）。

   ── 不含什么 ──────────────────────────────────────────────────

   · 思考（`reasoning`）：那是过程，收在折叠区
   · 工具调用（`toolRuns`）：同上
   · 「过程话」那几轮的正文：界面把它们收进折叠区了，不算正文
     （要带过程请用「复制完整记录」）

   ── 保真 ──────────────────────────────────────────────────────

   原样返回 Markdown 原文（不转义、不裁行），多段之间用空行分隔 ——
   界面上一段一段分开显示，粘出去也该是一段一段。
   ══════════════════════════════════════════════════════════════ */

/** 这条消息**界面上看到的正文**（纯文本，Markdown 原文） */
export function bodyTextOf(message: Message): string {
  /* 用户 / 系统消息：只有一个 content，没有轮次这回事 */
  if (message.role !== 'assistant') return message.content

  const rounds = roundsOf(message)
  const kept = rounds
    .filter((_, index) => !isProcessSpeech(rounds, index))
    .map((round) => round.content.trim())
    .filter(Boolean)

  /*
   * 一轮正文都没有（整轮只有思考 / 工具）→ 退回 content。
   * 那种情况下界面上确实没有正文块，但 content 若是唯一存在的文字，
   * 复制它比复制空串有用（「复制了什么都得不到」是更糟的体验）。
   */
  if (kept.length === 0) return message.content
  return kept.join('\n\n')
}
