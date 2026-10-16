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
export function MessageBody({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div aria-label="回复正文" className="text-fg-primary">
      <Suspense
        fallback={<div className="whitespace-pre-wrap text-dense text-fg-primary">{text}</div>}
      >
        <Markdown text={text} />
      </Suspense>
      {/* 流式光标：只在还没完、也没出错时显示（与拆之前一致） */}
      {streaming ? <span className="text-fg-tertiary">▍</span> : null}
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
}

export function TurnBubble({ turn }: { turn: TurnView }) {
  return (
    <>
      {turn.ask ? (
        <div className="mb-2 rounded-base bg-bg-raised px-2 py-1.5 text-fg-secondary">{turn.ask}</div>
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
