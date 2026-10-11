/* ══════════════════════════════════════════════════════════════
   Markdown 缺口对拍样例集（Phase 3 · Q1）

   CommonMark 0.31 + GFM 里**高频**的那些语法，每条写清「规格要求得到什么」。
   `gfm-gap.test.ts` 拿它跑自研解析器，量出与规格的差距。

   期望值写的是**规格语义**（CommonMark/GFM 文档规定），不是自研实现的现状 ——
   现状与规格不符的，就是缺口。
   ══════════════════════════════════════════════════════════════ */

export interface GapCase {
  id: string
  /** 这条考的是哪条语法 */
  spec: string
  input: string
  /** 期望的**块类型**序列（headings 记成 h1..h6） */
  blocks?: string[]
  /** 期望的**行内节点**类型序列（单段落内容） */
  inline?: string[]
  /** 期望的首个行内节点纯文本（查实体 / 转义是否被解开） */
  inlineText?: string
}

export const CASES: readonly GapCase[] = [
  /* ── 块级：标题 ─────────────────────────────────────────── */
  { id: 'atx-h1', spec: 'ATX 标题', input: '# 标题', blocks: ['h1'] },
  { id: 'atx-h3', spec: 'ATX 标题（多级）', input: '### 标题', blocks: ['h3'] },
  { id: 'atx-closed', spec: 'ATX 标题（尾随井号）', input: '## 标题 ##', blocks: ['h2'] },
  { id: 'setext-h1', spec: 'setext 标题 ===', input: '标题\n====', blocks: ['h1'] },
  { id: 'setext-h2', spec: 'setext 标题 ---', input: '标题\n----', blocks: ['h2'] },

  /* ── 块级：分隔线 ───────────────────────────────────────── */
  { id: 'hr-dash', spec: '分隔线 ---', input: '---', blocks: ['hr'] },
  { id: 'hr-star', spec: '分隔线 ***', input: '***', blocks: ['hr'] },

  /* ── 块级：代码块 ───────────────────────────────────────── */
  { id: 'fence-tick', spec: '围栏代码块 ```', input: '```js\nx\n```', blocks: ['code'] },
  { id: 'fence-tilde', spec: '围栏代码块 ~~~', input: '~~~\nx\n~~~', blocks: ['code'] },
  {
    id: 'fence-unclosed',
    spec: '未闭合围栏（到文档末尾仍是代码块）',
    input: '```\nx',
    blocks: ['code'],
  },
  { id: 'indented-code', spec: '缩进代码块（4 空格）', input: '    x', blocks: ['code'] },

  /* ── 块级：引用 / 列表 ──────────────────────────────────── */
  { id: 'quote', spec: '引用', input: '> a', blocks: ['quote'] },
  { id: 'quote-nested', spec: '嵌套引用', input: '> > a', blocks: ['quote'] },
  { id: 'ul', spec: '无序列表', input: '- a\n- b', blocks: ['ul'] },
  { id: 'ol', spec: '有序列表', input: '1. a\n2. b', blocks: ['ol'] },
  { id: 'ul-nested', spec: '嵌套列表', input: '- a\n  - b', blocks: ['ul'] },
  { id: 'task', spec: 'GFM 任务列表', input: '- [x] 做完了', blocks: ['ul'] },

  /* ── 块级：GFM 表格 / HTML / 数学 ───────────────────────── */
  {
    id: 'table',
    spec: 'GFM 表格',
    input: '| a | b |\n| - | - |\n| 1 | 2 |',
    blocks: ['table'],
  },
  { id: 'html-block', spec: 'HTML 块', input: '<div>x</div>', blocks: ['html'] },
  { id: 'math', spec: '$ 数学块（本项目扩展）', input: '$$\nx\n$$', blocks: ['math'] },

  /* ── 块级：段落边界 ─────────────────────────────────────── */
  { id: 'para-multiline', spec: '段落（软换行合并）', input: 'a\nb', blocks: ['paragraph'] },
  { id: 'para-split', spec: '空行分段', input: 'a\n\nb', blocks: ['paragraph', 'paragraph'] },
  { id: 'heading-then-para', spec: '标题后接正文', input: '# h\n\na', blocks: ['h1', 'paragraph'] },

  /* ── 行内 ───────────────────────────────────────────────── */
  { id: 'em-star', spec: '斜体 *x*', input: '*x*', inline: ['italic'] },
  { id: 'em-underscore', spec: '斜体 _x_', input: '_x_', inline: ['italic'] },
  { id: 'strong-star', spec: '粗体 **x**', input: '**x**', inline: ['bold'] },
  { id: 'strong-underscore', spec: '粗体 __x__', input: '__x__', inline: ['bold'] },
  { id: 'strike', spec: 'GFM 删除线 ~~x~~', input: '~~x~~', inline: ['strike'] },
  { id: 'code-inline', spec: '行内代码', input: '`x`', inline: ['code'] },
  { id: 'link', spec: '链接 [a](u)', input: '[a](https://x.com)', inline: ['link'] },
  {
    id: 'link-relative',
    spec: '相对链接 [a](u)（规格允许；本项目有意只放行安全协议）',
    input: '[a](u)',
    inline: ['link'],
  },
  { id: 'image', spec: '图片 ![a](u)', input: '![a](https://x.com)', inline: ['image'] },
  { id: 'autolink', spec: '自动链接 <https://x>', input: '<https://x.com>', inline: ['link'] },
  { id: 'bare-url', spec: 'GFM 裸 URL 自动链接', input: 'https://x.com', inline: ['link'] },
  { id: 'entity', spec: '实体 &amp; → &', input: 'a&amp;b', inlineText: 'a&b' },
  { id: 'escape', spec: '转义 \\* → *', input: '\\*x\\*', inlineText: '*x*' },
]
