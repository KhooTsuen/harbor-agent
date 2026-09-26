/* ══════════════════════════════════════════════════════════════
   Markdown 入口

   原来是单文件 `markdown.ts`（220 行）。补上表格 / 任务列表 / 嵌套
   之后会超 300 行，拆成 types / inline / table / blocks，本文件只导出。
   ══════════════════════════════════════════════════════════════ */

export type { Align, BlockNode, InlineNode, ListItem } from './types'
export { parseFenceInfo } from './blocks'
export { parseInline, plainText, extractImageUrls } from './inline'
export { parseBlocks } from './blocks'
export { isTableSeparator, splitRow } from './table'
/* 流式增量解析（AG-021/AG-022）—— 渲染层从这里取，别从深路径 require */
export {
  EMPTY_CACHE,
  findStablePoint,
  parseIncremental,
  isIncompleteLine,
  splitPendingLine,
  type IncrementalResult,
  type StableCache,
} from './incremental'

/**
 * 有没有值得解析的 Markdown 记号。
 *
 * 纯文字（大多数简短回复）直接当段落渲染，省一次整篇解析 ——
 * 长对话里这条短路省下的时间不算小。
 */
export function hasMarkdown(text: string): boolean {
  return /(^|\n)\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|[-*_]{3,}|\|)|\*\*|__|`|~~|!\[|\[[^\]]*\]\(|https?:\/\/|\\\n| {2,}\n/.test(
    String(text ?? ''),
  )
}
