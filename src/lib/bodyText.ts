import type { Message } from '@/types'
import { roundsOf } from '@/components/chat/message/roundsOf'
import { isProcessSpeech } from '@/components/chat/message/groupRounds'

/* ══════════════════════════════════════════════════════════════
   一条消息的「正文」—— **显示、复制、导出三处共用这一份**（2026-11-09）

   ── 为什么要集中到一处 ────────────────────────────────────────
   用户报的 bug：点「复制正文」，剪贴板内容和屏幕上看到的对不上。
   根因是取数走了两条路 ——
     · 界面：`MessageRounds` 逐轮画 `rounds[i].content`，跳过「过程话」
     · 复制：直接 `message.content`（**只有最后一轮**）
   一条 Agent 消息常有多轮正文（「我先看 A」→工具→「A 没问题」→工具→「结论」），
   其中没调工具的轮按判据算正文、界面上明明显示着，复制却拿不到。

   修完之后又多出一处不一致：**导出**那条路还在用 `message.content`。
   三处各自取数，迟早再漂一次 —— 所以正文的判据收到这里一处，
   `bodyTextOf`（复制）、`MessageRounds`（显示）、`threadToMarkdown`（导出）都问它。

   ── 判据 ──────────────────────────────────────────────────────
   复用渲染层那一份（`isProcessSpeech`），不另写：**有两份判据就一定会漂开**。
   放在 `lib/` 是为了让导出（`lib/export.ts`）能直接引用，不必反向依赖组件。

   ── 不含什么 ──────────────────────────────────────────────────
   思考、工具调用、「过程话」那几轮的正文（界面把它们收进折叠区了）。
   要连过程一起带走，用「复制完整记录」或导出。

   ── 保真 ──────────────────────────────────────────────────────
   原样返回 Markdown 原文（不转义、不裁行），多段之间空行分隔。
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
   * 那时界面上确实没有正文块，但 content 若是唯一存在的文字，
   * 复制它比复制空串有用（「复制了什么都得不到」是更糟的体验）。
   */
  if (kept.length === 0) return message.content
  return kept.join('\n\n')
}
