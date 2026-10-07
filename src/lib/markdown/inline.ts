import type { InlineNode } from './types'
import { isSafeHref } from '@/lib/linkPolicy'

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

/* 链接白名单在 linkPolicy.ts（与搜索结果引用共用一个判据）；
   这里只管「像不像链接」，`javascript:` / `file:` 之类一律当普通文字 */

/*
 * 会被当行内 HTML 的标签名。
 *
 * 用白名单而不是「任意 `<xxx>`」是为了少误伤 —— 正文里 `useState<string>`、
 * `a <b> c` 这类写法很常见，放行任意标签名会把普通回答搅乱。
 * 标签在名单内即直通（**含属性**，所以 `onerror=` 这类也会执行 —— 见
 * `RawHtml.tsx` 的安全说明，这是刻意开的口子）。
 */
const HTML_TAGS = new Set([
  'a',
  'abbr',
  'audio',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'button',
  'canvas',
  'cite',
  'code',
  'col',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
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
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'main',
  'mark',
  'menu',
  'meter',
  'nav',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'svg',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
])

const RULES: Rule[] = [
  /* 行内代码优先级最高：里面的 * 和 _ 都不该被解析 */
  { re: /`([^`\n]+)`/, build: (m) => ({ type: 'code', text: m[1] }) },

  /* 原始 HTML 直通：配对元素优先，其次单标签（标签名单见 HTML_TAGS） */
  {
    re: /<([a-zA-Z][\w-]*)(?:"[^"]*"|'[^']*'|[^>])*>([\s\S]*?)<\/\1\s*>/,
    build: (m) => (HTML_TAGS.has(m[1].toLowerCase()) ? { type: 'html', html: m[0] } : null),
  },
  {
    re: /<\/?([a-zA-Z][\w-]*)(?:"[^"]*"|'[^']*'|[^>])*?\/?>/,
    build: (m) =>
      HTML_TAGS.has(m[1].toLowerCase()) || /\/>$/.test(m[0]) || m[0].startsWith('</')
        ? { type: 'html', html: m[0] }
        : null,
  },

  /* 行内公式 $…$（`$$` 归块级；两侧不留空白，免得「$100 和 $200」被吃） */
  {
    re: /(?<!\$)\$(?!\$|\s)([^\n$]*?)(?<!\s)\$(?!\$)/,
    build: (m) => ({ type: 'math', text: m[1] }),
  },

  /* 图片要排在链接前面，否则 `![a](b)` 会被链接规则吃掉开头的 `!` */
  {
    re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) =>
      /^(https?:|file:|data:image\/|\/|\.\/|\.\.\/)/i.test(m[2])
        ? { type: 'image', src: m[2], alt: m[1] }
        : null,
  },
  {
    re: /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) =>
      isSafeHref(m[2]) ? { type: 'link', href: m[2], children: parseInline(m[1]) } : null,
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
        case 'math':
          return node.text
        case 'html':
          return node.html.replace(/<[^>]*>/g, '')
        case 'br':
          return '\n'
        default:
          return plainText(node.children)
      }
    })
    .join('')
}

/**
 * 从一段 markdown 里把所有图片地址抠出来。
 *
 * 用在工具卡片上：工具输出是纯文本（`<pre>`），里面的 `![图](x)` 只会显示成
 * 一堆方括号 —— 生图工具明明返回了图，用户却只能看到文件路径。
 * 把它们抠出来单独渲染成缩略图。
 */
export function extractImageUrls(text: string): string[] {
  const found: string[] = []
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (/^(https?:|file:|data:image\/)/i.test(match[1])) found.push(match[1])
  }
  return [...new Set(found)]
}
