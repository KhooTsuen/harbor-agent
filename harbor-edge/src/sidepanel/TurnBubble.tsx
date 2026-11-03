/**
 * 一轮对话的**显示**（ChatPanel 拆出来的，2026-10-16）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * `ChatPanel.tsx` 贴 300 红线，而 M02-A 要往它加「Markdown 渲染 + 停止按钮」。
 * 这一块（提问气泡 + 回复正文 + 错误 + 完成行）自成一体：它**只管显示**，
 * 不知道消息怎么发、抽屉怎么开、停止按钮接哪。
 *
 * ── ★ Markdown 渲染：复用主应用那一份（硬约束 #9）─────────────
 *
 * 解析用 `@/lib/markdown` 的 `parseBlocks` —— **与主窗口同一份**。侧边栏若自己
 * 写一套解析，同一段文字在两处会渲染成不同的块（代码围栏 / 表格 / 列表的边界
 * 判断最容易漂），那正是硬约束 #9 要消灭的「两边各一套」。
 *
 * 渲染**懒加载**主应用的 `Markdown`（`lazy()`）：它的链里有 katex（1.6MB 带 CSS）
 * 与 `CodeBlock → @/lib/backend` —— 侧边栏首屏不该背这个包袱。
 * 加载完成前的兜底是**纯文本**（不是空白）：面板打开时不会闪一片空。
 *
 * ⚠️ `回复正文` 这个 aria-label 是验收脚本的锚点（`accept-phase3b` 的
 *    `REPLY_TEXT`）—— 换了渲染组件也**必须**留在同一处，否则判据静默失效。
 */

import { lazy, Suspense } from 'react'
import { ThinkBlock } from '@/components/chat/ProcessBlocks'

/** 主应用的 Markdown（懒加载：katex 与 CodeBlock 不该进侧边栏首屏） */
const Markdown = lazy(async () => {
  const mod = await import('@/components/chat/Markdown')
  return { default: mod.Markdown }
})

/**
 * 一段 Markdown 正文。加载中 / 加载失败都退回**纯文本**（不空白、不报错）。
 *
 * 为什么失败要退纯文本：侧边栏是**用户正在用的界面**，一个渲染组件加载不了
 * 不该让回复看不见（那比「没有排版」糟得多）。
 */
export function MessageBody({
  text,
  streaming,
  /*
   * ★ 2026-11-03：`anchor` 控制要不要带那个验收锚点 label（值就是「回复正文」四个字）。
   *
   *   侧边栏现在会显示**整条会话**（历史 + 正在流的那一轮），历史里也可能有
   *   很多条 assistant 正文。而验收脚本是用 `document.querySelector` 取**第一个**
   *   带这个 label 的元素（见 `harbor-edge/tools/accept-phase3b.cjs` 的 REPLY_TEXT）
   *   —— 历史若也带，脚本读到的就是最早那条旧回复，这个锚点会
   *   **静默指错地方**（脚本照跑不误、判据看着还绿）。
   *
   *   所以：只有**正在流的那一条**带 label（默认 true），历史条传 false。
   *   锚点仍只有一处，语义也更准确（它本来就是「当前这条回复」）。
   */
  anchor = true,
}: {
  text: string
  streaming: boolean
  anchor?: boolean
}) {
  return (
    <div {...(anchor ? { 'aria-label': '回复正文' } : {})} className="text-fg-primary">
      <Suspense
        fallback={<div className="whitespace-pre-wrap text-dense text-fg-primary">{text}</div>}
      >
        <Markdown text={text} />
      </Suspense>
      {/*
        流式光标（D⑤）：以前是一个字符 `▍` —— 它是**正文颜色**的死字，
        换主题不变色，而且它在正文里占一个字宽，换行时会掉到下一行。
        改用主窗口那个 `.caret`（`src/index.css` 的 `::after` 伪元素）：
        随主题变色、流式结束就不再渲染（不留空）。

        `aria-hidden` 是必须的：它是装饰，读屏不该念出来。
      */}
      {streaming ? <span className="caret" aria-hidden="true" /> : null}
    </div>
  )
}

/** 一轮对话的显示（提问 + 回复 + 错误 / 完成） */
export interface TurnView {
  /** 用户发的那句 */
  ask: string
  /** 回答正文（流式累加） */
  text: string
  /** 已收到的最大 seq（只认更大的，防重排） */
  seq: number
  done: boolean
  error?: string | null
  /**
   * 这一轮的思考（流式累加）—— 2026-11-04 补。
   *
   * 以前这个形状里没有它，于是 `reasoning` 分片虽然一直被主进程推到侧边栏
   * （`ext-chat-streams.cjs` 的 `PUSH_TYPES`），渲染层却没有地方接住。
   * 现在它和正文一样是时间线的一部分：流式中由 `useChatStream` 累加，
   * 跑完后由 `mergeMessages` 挑更完整的那份。
   */
  reasoning?: string
}

export function TurnBubble({ turn }: { turn: TurnView }) {
  const thinking = String(turn.reasoning ?? '').trim()
  return (
    <>
      {turn.ask ? (
        <div className="mb-2 rounded-base bg-bg-raised px-2 py-1.5 text-fg-secondary">
          {turn.ask}
        </div>
      ) : null}
      {/* 思考放在正文上方（与主窗口一个位置）；`streaming` 只在正文还没出时才是「正在思考…」 */}
      {thinking ? (
        <ThinkBlock text={thinking} streaming={!turn.done && !turn.error && !turn.text.trim()} />
      ) : null}
      <MessageBody text={turn.text} streaming={!turn.done && !turn.error} />
      {turn.error ? (
        <div aria-label="回复错误" className="mt-1 text-2xs text-danger">
          {turn.error}
        </div>
      ) : null}
      {turn.done && !turn.error ? (
        <div className="mt-1 text-2xs text-fg-tertiary">已完成（同一条也在 Harbor 主窗口里）</div>
      ) : null}
    </>
  )
}
