import type { Message } from '@/types'
import { parseFileCitation, parseSearchCitations } from './parseToolOutput'

/* ══════════════════════════════════════════════════════════════
   从工具输出里捞「可追溯的东西」（真机反馈那一批顺出来的）

   `streamEvents.ts` 一直贴着 300 行（硬约束 #2），而这一段自己是完整的：
   只要是这两种工具的输出，就把引用解析出来。

   解析失败一律吞掉 —— 引用是**加分项**，不能因为格式怪就让整轮对话失败。
   ══════════════════════════════════════════════════════════════ */

/** 返回值：这一条工具输出里能捞到的引用（捞不到就是空数组） */
export function citationsOf(
  event: Record<string, unknown>,
  output: string,
): NonNullable<Message['citations']> {
  try {
    const path =
      typeof event.path === 'string'
        ? event.path
        : String((event.args as Record<string, unknown>)?.path ?? '')
    const found = event.name === 'read_file' ? parseFileCitation(output, path) : null
    const web = event.name === 'search_web' ? parseSearchCitations(output) : []
    return [...(found ? [found] : []), ...web]
  } catch {
    return []
  }
}
