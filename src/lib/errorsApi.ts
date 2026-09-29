import type { ErrorEntry, ErrorListResult } from '@/types/errors'
import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   「错误」清单的桥包装

   和后端（内核 `error-reader.cjs`）的关系：
     · **只读** —— 这一个模块没有任何写操作，界面看错误清单不该改数据
     · 浏览器预览没有桥 → 返回空结果而不是抛异常（设置页/面板要能正常显示「桌面版才有」）

   空结果的分寸：`ok: false` 表示「读失败」，`ok: true` + 空 entries 才是「确实没有错误」。
   两者不能混 —— 混了就会把「读不出来」显示成「一切正常」，那是最误导人的一种显示。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

const EMPTY: ErrorListResult = { ok: true, dir: '', entries: [], stats: {} }

/** 读错误清单（观察哨记的那些）。days 默认后端定（7 天） */
export async function listErrors(options?: {
  days?: number
  limit?: number
}): Promise<ErrorListResult> {
  if (!bridge?.errorsList) return { ...EMPTY, reason: '桌面版才有（浏览器预览读不到磁盘）' }
  try {
    const result = await bridge.errorsList(options)
    return {
      ...EMPTY,
      ...result,
      entries: Array.isArray(result?.entries) ? result.entries : [],
    }
  } catch (error) {
    /* 跨进程抛异常拿不到栈，能给的只有这一句 —— 也要给出来，别装作没事 */
    return { ...EMPTY, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 一条错误 → 一段能直接粘给别人的文本（面板的「复制」用） */
export function formatEntryForCopy(entry: ErrorEntry): string {
  const time = (ms: number) => (ms ? new Date(ms).toLocaleString() : '—')
  return [
    `[${entry.severity}] ${entry.kind} × ${entry.count}`,
    `  ${entry.message}`,
    `  位置：${entry.location}`,
    `  首次：${time(entry.firstSeen)}　最后：${time(entry.lastSeen)}`,
    entry.raw && entry.raw !== entry.message ? `  原文：${entry.raw}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 整份清单 → Markdown（复制/存文件都用它） */
export function formatReport(result: ErrorListResult): string {
  const lines = [
    `# 错误清单（最近 ${result.stats?.days ?? '?'} 天）`,
    '',
    `- 位置：\`${result.dir}\``,
    `- 文件：${result.stats?.files ?? 0}/${result.stats?.filesTotal ?? 0}　原始 ${result.stats?.raw ?? 0} 条 → 合并 ${result.stats?.unique ?? 0} 条`,
    '',
  ]
  for (const entry of result.entries) {
    lines.push(formatEntryForCopy(entry), '')
  }
  return lines.join('\n')
}
