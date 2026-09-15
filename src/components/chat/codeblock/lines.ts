import type { TokenKind } from '@/lib/highlight'
import { tokenize } from '@/lib/highlight'

/* ══════════════════════════════════════════════════════════════
   把 token 流切成「一行一数组」

   token 内部可能含换行（多行字符串、块注释），所以切完还要再拆一次，
   否则多行字符串会把整段代码挤成一行。
   ══════════════════════════════════════════════════════════════ */

export interface Piece {
  kind: TokenKind
  text: string
}

export function splitTokens(code: string, language: string): Piece[][] {
  const lines: Piece[][] = [[]]

  for (const token of tokenize(code, language)) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ kind: token.kind, text: part })
    })
  }

  return lines
}

/** 行号栏宽度：按最大行号定，免得滚动时宽度忽宽忽窄 */
export function gutterWidth(total: number): string {
  return `${String(total).length + 1}ch`
}
