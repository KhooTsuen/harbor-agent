import type { Align, InlineNode } from './types'
import { parseInline } from './inline'

/* ══════════════════════════════════════════════════════════════
   GFM 表格

   分割线形如 |---|:--:|---:|   每格的对齐方式由冒号位置决定。
   ══════════════════════════════════════════════════════════════ */

const RE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/** 这一行是不是表格的分割线（至少要有一个减号，否则 `| |` 也算） */
export function isTableSeparator(line: string): boolean {
  return line.includes('-') && RE_SEPARATOR.test(line)
}

/** 拆一行单元格：`\|` 是转义的竖线，不当分隔符 */
export function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)

  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      buf += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf)

  return cells.map((cell) => cell.trim())
}

export function parseAlign(separator: string): Align[] {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

export function parseRow(line: string): InlineNode[][] {
  return splitRow(line).map(parseInline)
}
