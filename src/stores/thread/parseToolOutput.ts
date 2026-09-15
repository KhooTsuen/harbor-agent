import type { Message } from '@/types'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   从工具输出里解析出可追溯的东西

   · 搜索结果是网页 → Web Citation（标题 / URL / 域名 / 抓取时间）
   · 带文件名的代码块 → Artifact 元数据（**只记元信息，不动真实文件**）
   · 文件读取结果 → 文件 Citation

   从 turns.ts 拆出来的：那边是「发消息 + 处理流式事件」的主流程，
   这几个是纯字符串解析，混在一起两边都难读。
   ══════════════════════════════════════════════════════════════ */

export function extractArtifacts(
  content: string,
  sourceMessageId: string,
): NonNullable<Message['artifacts']> {
  const out: NonNullable<Message['artifacts']> = []
  const pattern = /```(?:[\w+-]+)?(?:\s+(?:title=)?["']?([^\s"'`]+)["']?)?\n[\s\S]*?```/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1]
    if (!name || name.length > 160 || !/[./]/.test(name)) continue
    out.push({
      id: uid('artifact'),
      type: 'code',
      name,
      path: name,
      sourceMessageId,
      createdAt: Date.now(),
    })
  }
  return out
}

export function parseFileCitation(
  result: string,
  path?: string,
): NonNullable<Message['citations']>[number] | null {
  if (!path || !result.trim()) return null
  const lines = result.split(/\r?\n/).filter(Boolean)
  const end = lines.length
  return {
    id: `file-${path}-${Date.now()}`,
    kind: 'file',
    title: path,
    path,
    startLine: 1,
    endLine: end,
    snippet: lines.slice(0, 2).join(' ').slice(0, 240),
    fetchedAt: Date.now(),
  }
}

export function parseSearchCitations(result: string): NonNullable<Message['citations']> {
  const lines = result.split(/\r?\n/)
  const out: NonNullable<Message['citations']> = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(\d+)\.\s+(.+)$/.exec(lines[i] ?? '')
    const url = lines[i + 1]?.trim()
    if (!match || !/^https?:\/\//i.test(url ?? '')) continue
    let domain = ''
    try {
      domain = new URL(url).hostname
    } catch {
      /* ignore malformed source */
    }
    out.push({
      id: `web-${match[1]}`,
      kind: 'web',
      title: match[2].trim(),
      url,
      domain,
      fetchedAt: Date.now(),
    })
  }
  return out
}

/** 工具参数摘要，别把整坨 JSON 摊在界面上 */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : ''
  const command = typeof args.command === 'string' ? args.command : ''
  if (name === 'run_shell') return command.slice(0, 100)
  if (name === 'list_dir') return path || '.'
  if (path) return path
  return JSON.stringify(args).slice(0, 80)
}
