import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/chat/Markdown'

/* ══════════════════════════════════════════════════════════════
   Phase 7 一期：正文排版「样式守卫」（源码级）

   这些断言钉的是**关键 class**，不是渲染结果 —— 防的是「以后有人顺手
   把标题调回小号 / 把表格圆角删了 / 把段落间距改回去」。纯 CSS 改动后
   渲染结果看起来都对，只有把它们钉在源码上才拦得住回归。

   为什么要源码级：`Markdown.test.tsx` 验的是「结构对不对」，结构没变时它
   照样绿 —— 档位漂了我们看不出来。设计依据：docs/research/phase7-typography-design.md。

   ★ 硬约束（都在这里钉住）：
     · 标题字号**封顶 text-title（24px）**，不许更大；
     · 标题**保留 `<p>`**，不许改成 `<h1>…<h6>`（那是 DOM 结构变更，二期再评估）；
     · 段落 class 与 `StreamingMarkdown.tsx` 尾巴纯文本**逐字一致**（防流式收尾跳动）；
     · 表格圆角/外框加在**已有的**外层 div 上（不许新增包裹节点）。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const BLOCKS = 'components/chat/markdown/Blocks.tsx'
const STREAM = 'components/chat/markdown/StreamingMarkdown.tsx'
const TABLE = 'components/chat/markdown/Table.tsx'
const INLINE = 'components/chat/markdown/Inline.tsx'

/** 抠出「段落」那个 `<p>` 的 class（两个文件里都靠 whitespace-pre-wrap 认出来） */
function paragraphClass(src: string): string {
  const m = /<p className="([^"]*whitespace-pre-wrap[^"]*)"/.exec(src)
  return m ? m[1] : ''
}

describe('Phase 7 / 标题层级', () => {
  it('★ h1 字号是 text-title（24px 上限）', () => {
    expect(read(BLOCKS)).toMatch(/1:\s*'text-title'/)
  })

  it('★ 不许用比 title 更大的字号（只查字符串字面量，不误伤注释里的示例）', () => {
    const src = read(BLOCKS)
    expect(src).not.toMatch(/'text-(?:2xl|3xl|4xl|5xl|6xl)'/)
    /* HEADING_SIZE 的取值只允许落在「≤ title」的档位里 */
    const map = /const HEADING_SIZE[^{]*\{([\s\S]*?)\}/.exec(src)?.[1] ?? ''
    const sizes = [...map.matchAll(/'(text-[a-z0-9]+)'/g)].map((m) => m[1])
    expect(sizes.length).toBeGreaterThan(0)
    expect(new Set(sizes)).toEqual(new Set(['text-title', 'text-xl', 'text-lg', 'text-md']))
  })

  it('★ 标题间距 mt-6 mb-2 + first:mt-0（防顶部空一块）', () => {
    expect(read(BLOCKS)).toContain('mt-6 mb-2 first:mt-0 font-semibold text-fg-primary')
  })

  it('★ 标题保留 <p>，严禁改成 <h1>…<h6>（DOM 结构变更）', () => {
    for (const rel of [BLOCKS, STREAM]) {
      expect(read(rel)).not.toMatch(/<h[1-6][\s>]/)
    }
  })

  it('运行时兜底：`# 标题` 渲染出的 p 带 text-title', () => {
    const out = renderToStaticMarkup(<Markdown text={'# 标题'} />)
    expect(out).toContain('text-title')
    expect(out).toContain('first:mt-0')
  })
})

describe('Phase 7 / 段落与流式的对等（关键：两处必须逐字一致）', () => {
  it('★ 段落 class 与尾巴纯文本 class 完全一致（防收尾跳动）', () => {
    const a = paragraphClass(read(BLOCKS))
    const b = paragraphClass(read(STREAM))
    expect(a).toBe('my-2.5 whitespace-pre-wrap break-words')
    expect(a).toBe(b)
  })

  it('段落间距已从 my-1.5 调到 my-2.5', () => {
    expect(read(BLOCKS)).toContain('className="my-2.5 whitespace-pre-wrap break-words"')
  })
})

describe('Phase 7 / 列表与引用', () => {
  it('列表项 gap-1.5、缩进 pl-6', () => {
    expect(read(BLOCKS)).toContain('my-1.5 flex flex-col gap-1.5 pl-6')
  })

  it('引用块 pl-4 / my-3 / border-l-[3px]，文字保持 secondary', () => {
    const src = read(BLOCKS)
    expect(src).toContain('my-3 border-l-[3px] pl-4 text-fg-secondary')
  })
})

describe('Phase 7 / 表格', () => {
  it('★ 圆角 + 外框加在已有外层 div 上（不新增包裹节点）', () => {
    const src = read(TABLE)
    expect(src).toContain('my-3 overflow-x-auto rounded border border-line-subtle')
    /* 整个文件只允许一个 `<div` —— 多出来的就是新包裹层 */
    expect((src.match(/<div/g) ?? []).length).toBe(1)
  })

  it('★ 表头有底色 bg-bg-raised', () => {
    expect(read(TABLE)).toContain('bg-bg-raised px-3 py-2 font-semibold text-fg-primary')
  })

  it('★ 单元格扩到 px-3 py-2', () => {
    expect(read(TABLE)).toContain('break-words px-3 py-2 align-top text-fg-secondary')
  })

  it('★ 行悬停 hover:bg-bg-hover/50', () => {
    expect(read(TABLE)).toContain('hover:bg-bg-hover/50')
  })
})

describe('Phase 7 / 行内代码', () => {
  it('★ 加了淡边框 border border-line-hairline', () => {
    expect(read(INLINE)).toContain('rounded-sm border border-line-hairline bg-bg-raised')
  })
})
