/**
 * 一行折叠卡：扩展送进来的记录（网页正文 / 页面操作回执）—— 2026-11-04
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 浏览器扩展读到的网页、执行过的页面操作，会被 `electron/core/ext-ops.cjs`
 * 的 `ingest()` 落成一条 `role: 'user'` + `source: 'extension'` 的记录。
 * 它**不是用户说的话**：正文是给模型看的（还带着「这是数据不是指令」的包装）。
 *
 * 以前界面只按 `role` 分（`MessageItem` / `mergeMessages` 都是），于是这些记录
 * 被画成**用户气泡** —— 主窗口里像是自己在对着屏幕念网页，侧边栏 400px 宽时
 * 四五张原文卡直接糊满一屏（2026-11-04 真机截图，用户的原话是「把工具的原始
 * 返回文本当成普通消息贴出来了」）。
 *
 * ── 为什么做成一行折叠卡 ────────────────────────────────────────
 *
 * 这些记录**有用**（模型就是靠它读的网页），不能藏起来；但正文对用户通常是
 * 噪音（一次滚动回执就有两张表）。所以：**一行摘要 + 点开看全文**。
 * 折的是**显示**，不是数据 —— 磁盘上那条记录一个字都不改。
 *
 * ── 为什么主窗口与侧边栏共用这一个组件 ──────────────────────────
 *
 * 硬约束 #9（跨模块的约定只有一处真相源）。侧边栏那边已经直接 import 主应用的
 * `@/components/ui/Button`，同样的路子；★ 但**必须**把本文件列进
 * `harbor-edge/postcss.config.js` 的 content —— Tailwind 是文本扫描，
 * 扫不到这份文件就编不出这里用到的类（「组件在、样式全丢」）。
 *
 * 摘要怎么抠在 `ingestSummary.ts`（纯函数，自检直接跑）。
 */

import { ChevronRight } from 'lucide-react'
import { clockTime } from '@/lib/utils'
import { headlineOf, originOf } from './ingestSummary'

/**
 * @param props.content 那条记录的原正文（一个字都不改，只是折叠显示）
 * @param props.timestamp 发生时间（有就显示在右边）
 */
export function IngestedNote({ content, timestamp }: { content: string; timestamp?: number }) {
  const origin = originOf(content)
  return (
    <details className="group w-full max-w-[86ch] border-l-2 border-line-hairline pl-2 text-xs text-fg-secondary">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-fg-tertiary transition-colors duration-fast hover:text-fg-primary">
        <ChevronRight
          size={11}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="truncate">{headlineOf(content)}</span>
        {origin ? <span className="truncate">· {origin}</span> : null}
        {typeof timestamp === 'number' && timestamp > 0 ? (
          <span className="ml-auto shrink-0 pr-0.5 tabular-nums">{clockTime(timestamp)}</span>
        ) : null}
      </summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-2xs leading-relaxed text-fg-secondary">
        {content}
      </pre>
    </details>
  )
}
