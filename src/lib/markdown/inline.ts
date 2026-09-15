import type { InlineNode } from './types'

/* ══════════════════════════════════════════════════════════════
   行内解析

   策略：每轮在所有规则里挑「起始位置最靠前」的那个匹配，切一刀继续。
   同一起始位置时按规则数组顺序取（长的标记写在前面），
   所以 `**粗**` 不会被单个 `*` 抢走。

   命中后递归解析捕获组内部 —— 这样 `**粗里有*斜***` 也能出来。
   ══════════════════════════════════════════════════════════════ */

interface Rule {
  re: RegExp
  build: (match: RegExpExecArray) => InlineNode | null
}

/** 只放行这些开头的链接 —— `javascript:` 之类一律当普通文字 */
const SAFE_HREF = /^(https?:|\/|\.\/|\.\.\/|#|mailto:)/i

const RULES: Rule[] = [
  /* 行内代码优先级最高：里面的 * 和 _ 都不该被解析 */
  { re: /`([^`\n]+)`/, build: (m) => ({ type: 'code', text: m[1] }) },

  /* 图片要排在链接前面，否则 `![a](b)` 会被链接规则吃掉开头的 `!` */
  {
    re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) =>
      /^(https?:|data:image\/|\/|\.\/|\.\.\/)/i.test(m[2])
        ? { type: 'image', src: m[2], alt: m[1] }
        : null,
  },
  {
    re: /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) =>
      SAFE_HREF.test(m[2]) ? { type: 'link', href: m[2], children: parseInline(m[1]) } : null,
  },

  /* 自动链接：裸 URL（前面不能紧跟字母或斜杠，免得把 URL 内部切开） */
  {
    re: /(?<![\w/])(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?])/,
    build: (m) => ({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }] }),
  },

  { re: /\*\*([\s\S]+?)\*\*/, build: (m) => ({ type: 'bold', children: parseInline(m[1]) }) },
  { re: /__([\s\S]+?)__/, build: (m) => ({ type: 'bold', children: parseInline(m[1]) }) },
  { re: /~~([\s\S]+?)~~/, build: (m) => ({ type: 'strike', children: parseInline(m[1]) }) },
  { re: /\*([^*\n]+?)\*/, build: (m) => ({ type: 'italic', children: parseInline(m[1]) }) },
  { re: /_([^_\n]+?)_/, build: (m) => ({ type: 'italic', children: parseInline(m[1]) }) },

  /* 行尾两个空格 = 硬换行 */
  { re: / {2,}\n/, build: () => ({ type: 'br' }) },
  /* 行尾反斜杠也是硬换行 */
  { re: /\\\n/, build: () => ({ type: 'br' }) },
  /* 反斜杠转义 */
  {
    re: /\\([\\`*_{}[\]()#+.!>~-])/,
    build: (m) => ({ type: 'text', text: m[1] }),
  },
]

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let rest = String(input ?? '')

  while (rest.length > 0) {
    let best: { index: number; match: RegExpExecArray; rule: Rule } | null = null

    for (const rule of RULES) {
      const match = rule.re.exec(rest)
      if (!match) continue
      if (best === null || match.index < best.index) best = { index: match.index, match, rule }
    }

    if (!best) {
      nodes.push({ type: 'text', text: rest })
      break
    }

    const built = best.rule.build(best.match)
    if (!built) {
      /* 规则拒了（危险链接等）：把这段当普通文字，越过它继续 */
      const end = best.index + best.match[0].length
      nodes.push({ type: 'text', text: rest.slice(0, end) })
      rest = rest.slice(end)
      continue
    }

    if (best.index > 0) nodes.push({ type: 'text', text: rest.slice(0, best.index) })
    nodes.push(built)
    rest = rest.slice(best.index + best.match[0].length)
  }

  return mergeText(nodes)
}

/** 相邻的文本节点合并一下 —— 少几个 React 元素，也少几次 diff */
function mergeText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (node.type === 'text' && node.text === '') continue
    if (last && last.type === 'text' && node.type === 'text') {
      last.text += node.text
      continue
    }
    out.push(node)
  }
  return out
}

/** 取行内节点的纯文字（图片 alt、复制按钮用） */
export function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.text
        case 'image':
          return node.alt
        case 'br':
          return '\n'
        default:
          return plainText(node.children)
      }
    })
    .join('')
}
