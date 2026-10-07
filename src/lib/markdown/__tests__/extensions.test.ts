import { describe, expect, it } from 'vitest'
import type { BlockNode, InlineNode } from '@/lib/markdown'
import {
  EMPTY_CACHE,
  parseBlocks,
  parseIncremental,
  parseInline,
  type StableCache,
} from '@/lib/markdown'

/* ══════════════════════════════════════════════════════════════
   扩展语法的解析：HTML 直通 / 公式（KaTeX 输入）/ Mermaid 承载块

   重点两条：
     · 新语法能被认出来（别把 `<div>` 直接摆给用户看）
     · **别误伤**（`useState<string>`、`$100 和 $200` 这类正常文字不能被吃）
   ══════════════════════════════════════════════════════════════ */

const hasHtml = (nodes: InlineNode[]) => nodes.some((n) => n.type === 'html')

describe('行内 HTML 直通', () => {
  it('配对元素整段直通', () => {
    const nodes = parseInline('前 <b>粗</b> 后')
    expect(nodes).toContainEqual({ type: 'html', html: '<b>粗</b>' })
  })

  it('单标签 / 自闭合也直通（带属性一起走）', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')[0]).toEqual({
      type: 'html',
      html: '<img src=x onerror=alert(1)>',
    })
  })

  it('★ 泛型写法不被误吞', () => {
    const nodes = parseInline('用 useState<string> 记状态')
    expect(nodes.every((n) => n.type !== 'html')).toBe(true)
  })

  it('行内代码里的标签不直通', () => {
    expect(parseInline('`<b>x</b>`')).toEqual([{ type: 'code', text: '<b>x</b>' }])
  })
})

describe('行内公式', () => {
  it('$…$ 成 math 节点', () => {
    expect(parseInline('质能方程 $E=mc^2$ 很好记')).toContainEqual({
      type: 'math',
      text: 'E=mc^2',
    })
  })

  it('★ 金额写法不被当公式', () => {
    const nodes = parseInline('一共 $100 和 $200')
    expect(nodes.every((n) => n.type !== 'math')).toBe(true)
  })

  it('$$ 不落进行内规则', () => {
    expect(parseInline('$$x$$').every((n) => n.type !== 'math')).toBe(true)
  })
})

describe('块级公式', () => {
  it('单行 $$x$$', () => {
    expect(parseBlocks('$$a^2+b^2$$')).toEqual([{ type: 'math', text: 'a^2+b^2' }])
  })

  it('跨行（含内容里换行）', () => {
    expect(parseBlocks('$$\na + b\nc\n$$')).toEqual([{ type: 'math', text: 'a + b\nc' }])
  })

  it('公式块打断段落', () => {
    const blocks = parseBlocks('前言\n\n$$\nx\n$$\n\n后记')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'math', 'paragraph'])
  })
})

describe('块级 HTML', () => {
  it('整块 HTML 直通', () => {
    expect(parseBlocks('<details>\n<summary>展开</summary>\n正文\n</details>')).toEqual([
      { type: 'html', html: '<details>\n<summary>展开</summary>\n正文\n</details>' },
    ])
  })

  it('空行就断开', () => {
    const blocks = parseBlocks('<div>甲</div>\n\n普通段落')
    expect(blocks.map((b) => b.type)).toEqual(['html', 'paragraph'])
  })

  it('行内标签不升级成块', () => {
    expect(parseBlocks('一段 <b>粗</b> 字')[0].type).toBe('paragraph')
  })
})

describe('★ 增量解析：新块类型也要与全文对拍', () => {
  const SAMPLES = [
    '$$a+b$$',
    '$$\na\n\nb\n$$',
    '前言\n\n$$\nx\n$$\n\n后记',
    '<div>\n<p>x</p>\n</div>',
    '<details>\n<summary>s</summary>\n</details>\n\n正文',
    '文字\n\n<details>\n甲\n</details>\n\n尾巴',
  ]

  function compare(text: string, step: number): string {
    let cache: StableCache = EMPTY_CACHE
    for (let i = 0; i <= text.length; i += step) {
      const current = text.slice(0, i)
      const result = parseIncremental(current, cache)
      cache = result.cache
      const expected: BlockNode[] = current ? parseBlocks(current) : []
      if (JSON.stringify(result.blocks) !== JSON.stringify(expected)) {
        return `i=${i}\n  增量=${JSON.stringify(result.blocks)}\n  全量=${JSON.stringify(expected)}`
      }
    }
    return ''
  }

  for (const text of SAMPLES) {
    it(`${JSON.stringify(text)} · 每次 1 字`, () => {
      expect(compare(text, 1)).toBe('')
    })
    it(`${JSON.stringify(text)} · 每次 3 字`, () => {
      expect(compare(text, 3)).toBe('')
    })
  }
})

/* 顺带钉住：Mermaid 只是「语言名」承载，解析层不认识它 —— 渲染层按 language 分流 */
describe('mermaid 承载块', () => {
  it('```mermaid 解析成普通代码块，语言名保留', () => {
    const blocks = parseBlocks('```mermaid\ngraph TD\n  A-->B\n```')
    expect(blocks[0]).toMatchObject({ type: 'code', language: 'mermaid' })
  })
})

/* 上面没直接用到 hasHtml 时会触发 no-unused —— 用它兜一个断言 */
describe('hasHtml helper sanity', () => {
  it('空段落里没有 html 节点', () => {
    expect(hasHtml(parseInline('纯文字'))).toBe(false)
  })
})
