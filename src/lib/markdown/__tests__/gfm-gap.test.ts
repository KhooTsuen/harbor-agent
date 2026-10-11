import { describe, expect, it } from 'vitest'
import type { BlockNode, InlineNode } from '../index'
import { parseBlocks, parseInline, plainText } from '../index'
import { CASES } from './gfm-cases'

/* ══════════════════════════════════════════════════════════════
   Markdown 缺口对拍（Phase 3 · Q1）

   拿 `gfm-cases.ts` 那批 CommonMark/GFM 样例跑自研解析器，量出**与规格的差距**。
   不引入第三方库（Q1 结论），所以缺口的处理方式是：**高频的补、低频的记为
   「已知差异」**（`KNOWN_GAPS`）。

   这个测试守两件事：
     ① 缺口集合不会**悄悄**变化（补了缺口就要把 id 从 KNOWN_GAPS 里删掉，
        否则测试红 —— 缺口可见，不会「以为补了其实没补」）；
     ② 跑的时候把缺口清单打出来，人一眼能看到现在差在哪。

   看当前缺口清单：`npx vitest run src/lib/markdown/__tests__/gfm-gap.test.ts`
   ══════════════════════════════════════════════════════════════ */

/** 块节点 → 规格里的类型名（headings 记成 h1..h6，列表按有序/无序分） */
function tagOf(node: BlockNode): string {
  if (node.type === 'heading') return `h${node.level}`
  if (node.type === 'list') return node.ordered ? 'ol' : 'ul'
  return node.type
}

/** 行内节点类型序列（嵌套的递归展开，方便比对） */
function inlineTags(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => node.type).join(',')
}

/* ── 已记录的「已知差异」（低频、暂不补）────────────────────
   补掉一个就从这里删一个 —— 删漏了上面 ① 会报红。
   ★ 由对拍实跑得出（见 Phase 3 实施报告的缺口清单）。 */
const KNOWN_GAPS: readonly string[] = [
  'setext-h1',
  'setext-h2',
  'indented-code',
  'link-relative',
  'autolink',
]

/** 单条样例是不是「符合规格」 */
function conforms(id: string, blocks: BlockNode[], input: string): boolean {
  const item = CASES.find((c) => c.id === id)!
  if (item.blocks) {
    const got = blocks.map(tagOf).join(',')
    if (got !== item.blocks.join(',')) return false
  }
  if (item.inline) {
    const inner = parseInline(input)
    if (inlineTags(inner) !== item.inline.join(',')) return false
  }
  if (item.inlineText !== undefined) {
    if (plainText(parseInline(input)) !== item.inlineText) return false
  }
  return true
}

describe('Markdown 缺口对拍（CommonMark/GFM）', () => {
  const gaps: string[] = []

  it('跑一遍全部样例，收集与规格不符的条目', () => {
    for (const item of CASES) {
      const blocks = parseBlocks(item.input)
      if (!conforms(item.id, blocks, item.input)) gaps.push(item.id)
    }
    /* 缺口清单打出来 —— 人看得到现在差在哪（附上期望 vs 实际，方便判断） */
    console.info(`\n[MD 对拍] 样例 ${CASES.length} 条 · 缺口 ${gaps.length} 条`)
    for (const id of gaps) {
      const item = CASES.find((c) => c.id === id)!
      const blocks = parseBlocks(item.input)
      const actual = item.blocks ? blocks.map(tagOf).join(',') : inlineTags(parseInline(item.input))
      const want = item.blocks
        ? item.blocks.join(',')
        : `${(item.inline ?? []).join(',')}${item.inlineText ? ` text=${item.inlineText}` : ''}`
      console.info(`  · GAP ${id}（${item.spec}）期望 [${want}] 实际 [${actual}]`)
    }
    console.info('')
  })

  it('缺口集合与「已知差异」记录一致（补了就要删，没补别悄悄多出来）', () => {
    expect([...gaps].sort()).toEqual([...KNOWN_GAPS].sort())
  })
})
