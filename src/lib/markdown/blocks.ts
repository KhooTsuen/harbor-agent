import type { BlockNode, InlineNode, ListItem } from './types'
import { parseInline } from './inline'
import { isTableSeparator, parseAlign, parseRow } from './table'

/* ══════════════════════════════════════════════════════════════
   块级解析

   逐行状态机。引用和列表会**递归**调用自己 —— 引用里能放列表、
   列表项里能放代码块，靠递归自然支持，不用为每种组合写分支。

   流式安全：所有「找结尾」的地方找不到就吃到文档末尾，
   所以渲染到一半的半截内容也不会崩。
   ══════════════════════════════════════════════════════════════ */

const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*(.*)$/
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/
const RE_QUOTE = /^\s*>\s?(.*)$/
const RE_UL = /^(\s*)[-*+]\s+(.*)$/
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const RE_TASK = /^\[([ xX])\]\s+([\s\S]*)$/

/** 缩进宽度（tab 当 4 格） */
function indentOf(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

/** 解析围栏后面的元信息：```ts title="a.ts" {1,3-5} */
export function parseFenceInfo(info: string): {
  language: string
  filename?: string
  highlightLines: number[]
} {
  let rest = info.trim()
  let filename: string | undefined
  const highlightLines: number[] = []

  const named = /(?:title|filename|file)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest)
  if (named) {
    filename = named[1] ?? named[2] ?? named[3]
    rest = rest.replace(named[0], ' ')
  }

  const braces = /\{([^}]*)\}/.exec(rest)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim())
      if (range) {
        const from = Number(range[1])
        const to = Math.min(Number(range[2]), from + 500)
        for (let n = from; n <= to; n += 1) highlightLines.push(n)
      } else if (/^\d+$/.test(part.trim())) {
        highlightLines.push(Number(part.trim()))
      }
    }
    rest = rest.replace(braces[0], ' ')
  }

  return { language: rest.trim().split(/\s+/)[0] ?? '', filename, highlightLines }
}

/** 能打断段落的行 */
function startsBlock(line: string): boolean {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line)
  )
}

export function parseBlocks(input: string): BlockNode[] {
  const lines = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): BlockNode[] {
  const blocks: BlockNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    /* ── 代码块 ── */
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const marker = fence[2][0]
      const close = new RegExp(`^\\s*${marker}{3,}\\s*$`)
      const info = parseFenceInfo(fence[3])
      i += 1
      const body: string[] = []
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({
        type: 'code',
        language: info.language,
        code: body.join('\n'),
        filename: info.filename,
        highlightLines: info.highlightLines,
      })
      continue
    }

    /* ── 分隔线（要在列表之前判，否则 `---` 会被当列表项） ── */
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    /* ── 标题 ── */
    const heading = RE_HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) })
      i += 1
      continue
    }

    /* ── 表格：本行含 |，下一行是分割线 ── */
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseRow(line)
      const align = parseAlign(lines[i + 1])
      i += 2
      const rows: InlineNode[][][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(parseRow(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', align, header, rows })
      continue
    }

    /* ── 引用 ── */
    if (RE_QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const quoted = RE_QUOTE.exec(lines[i])
        if (quoted) {
          inner.push(quoted[1])
          i += 1
          continue
        }
        /* 懒续行：引用里没写 > 的续行也算引用 */
        if (lines[i].trim() && !startsBlock(lines[i])) {
          inner.push(lines[i])
          i += 1
          continue
        }
        break
      }
      blocks.push({ type: 'quote', blocks: parseLines(inner) })
      continue
    }

    /* ── 列表 ── */
    const ul = RE_UL.exec(line)
    const ol = RE_OL.exec(line)
    if (ul || ol) {
      const ordered = Boolean(ol)
      const baseIndent = (ordered ? ol![1] : ul![1]).length
      const start = ordered ? Number(ol![2]) : 1
      const items: ListItem[] = []

      while (i < lines.length) {
        const match = ordered ? RE_OL.exec(lines[i]) : RE_UL.exec(lines[i])
        if (!match || match[1].length !== baseIndent) break

        let content = ordered ? match[3] : match[2]
        i += 1

        /* 收本项的续行：缩进更深的都算它的 */
        const nested: string[] = []
        while (i < lines.length) {
          const next = lines[i]
          if (!next.trim()) {
            const following = lines[i + 1]
            if (following && following.trim() && indentOf(following) > baseIndent) {
              nested.push('')
              i += 1
              continue
            }
            break
          }
          const indent = indentOf(next)
          if (indent > baseIndent) {
            /* 剥掉基准缩进，让递归解析看到的是正常的相对层级 */
            nested.push(next.slice(Math.min(indent, baseIndent + 2)))
            i += 1
            continue
          }
          break
        }

        /* 任务列表 */
        let checked: boolean | undefined
        const task = RE_TASK.exec(content)
        if (task) {
          checked = task[1].toLowerCase() === 'x'
          content = task[2]
        }

        /* 子块的第一段如果是段落，并回本项首行，避免被拆成两个段落 */
        const sub = nested.length > 0 ? parseLines(nested) : []
        let children = parseInline(content)
        let rest = sub
        const first = sub[0]
        if (first && first.type === 'paragraph') {
          children = [...children, { type: 'text', text: ' ' }, ...first.children]
          rest = sub.slice(1)
        }

        items.push({ children, blocks: rest, checked })
      }

      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    /* ── 段落 ── */
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      /* 中途冒出表格也断开 */
      if (lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break
      paragraph.push(lines[i])
      i += 1
    }
    if (paragraph.length === 0) {
      /* 兜底：谁都不匹配又不前进时，强制走一格免得死循环 */
      i += 1
      continue
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }

  return blocks
}
