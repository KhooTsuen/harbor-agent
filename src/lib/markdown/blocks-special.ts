import type { BlockNode } from './types'

/* ══════════════════════════════════════════════════════════════
   块级「扩展」语法：数学公式 $$…$$ 与原始 HTML 块

   单独一个文件，是因为 `blocks.ts` 已经贴着 300 行红线（AGENT.md 第 2 条），
   而这两块的判定互相独立、也方便单测，正好搬出来。

   ★ 增量解析安全（见 `incremental.ts`）：两者都靠**空行 / 闭合标记**分界，
     不改 `findStablePoint` 的围栏假设 —— 所以对拍测试不受影响。
   ══════════════════════════════════════════════════════════════ */

/* 单行闭合：`$$x^2$$` */
const RE_MATH_BLOCK = /^\s*\$\$(.*?)\$\$\s*$/
/* 跨行开头：`$$` （行尾可能还有内容） */
const RE_MATH_OPEN = /^\s*\$\$\s*(.*)$/

/*
 * 只有这些标签才把「整行开头」当 HTML 块；其余（`<b>`、`<span>`、`<br/>`…）
 * 交给行内规则处理。这样 `useState<string>` 这类泛型写法不会被误吞。
 */
const BLOCK_HTML_TAGS = new Set([
  'address',
  'article',
  'aside',
  'audio',
  'blockquote',
  'canvas',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'iframe',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'script',
  'section',
  'style',
  'summary',
  'svg',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'video',
])

const RE_HTML_OPEN = /^\s*<([a-zA-Z][\w-]*)\b/

function isBlockHtmlLine(line: string): boolean {
  const match = RE_HTML_OPEN.exec(line)
  return match ? BLOCK_HTML_TAGS.has(match[1].toLowerCase()) : false
}

/** 这一行是不是「扩展块」的开头（段落扫描时用它断开） */
export function startsSpecialBlock(line: string): boolean {
  return /^\s*\$\$/.test(line) || isBlockHtmlLine(line)
}

/**
 * 从第 `start` 行试着认一个扩展块。
 *
 * 认出来 → `{ node, next }`（next 是下一条待解析行的下标）；
 * 认不出 → null，交回常规解析。
 */
export function trySpecialBlock(
  lines: string[],
  start: number,
): { node: BlockNode; next: number } | null {
  const line = lines[start]

  /* ── $$…$$ ── */
  if (/^\s*\$\$/.test(line)) {
    const single = RE_MATH_BLOCK.exec(line)
    if (single) return { node: { type: 'math', text: single[1].trim() }, next: start + 1 }

    const open = RE_MATH_OPEN.exec(line) as RegExpExecArray
    const body: string[] = []
    if (open[1].trim()) body.push(open[1])

    let i = start + 1
    while (i < lines.length) {
      const close = /^(.*?)\$\$\s*$/.exec(lines[i])
      if (close) {
        if (close[1].trim()) body.push(close[1])
        return { node: { type: 'math', text: body.join('\n').trim() }, next: i + 1 }
      }
      body.push(lines[i])
      i += 1
    }
    /* 没闭合（流式中途）→ 吃到末尾，先当公式块渲染 */
    return { node: { type: 'math', text: body.join('\n').trim() }, next: i }
  }

  /* ── HTML 块：连续非空行 ── */
  if (isBlockHtmlLine(line)) {
    const body: string[] = []
    let i = start
    while (i < lines.length && lines[i].trim()) {
      body.push(lines[i])
      i += 1
    }
    return { node: { type: 'html', html: body.join('\n') }, next: i }
  }

  return null
}
