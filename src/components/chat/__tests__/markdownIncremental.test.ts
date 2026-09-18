import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   AG-021：接线守卫

   增量解析的值不值钱，全看 `Markdown` 组件有没有真的用它。
   `src/lib/markdown/incremental.ts` 自己测得再全，也拦不住
   「顺手把组件改回 `parseBlocks(text)`」——那种改动测试全绿，
   只是长回复流式时主线程又默默花掉两秒。

   所以这里守的是**接线**。按项目纪行：断言具体的传参表达式，
   而不是「关键词在不在」（那个已经踩过五次）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const md = readFileSync(join(ROOT, 'src/components/chat/Markdown.tsx'), 'utf8')

describe('AG-021 接线守卫', () => {
  it('★ Markdown 组件把全文交给增量解析，只把尾巴给 parseBlocks', () => {
    expect(md).toContain('parseIncremental(text, cache.current?.stable ?? EMPTY_CACHE)')
    /* 尾巴单独解析是故意的（它短、而且每次都变），但不能是全文 */
    expect(md).toContain('parseBlocks(tailText)')
    expect(md).not.toContain('parseBlocks(text)')
  })

  it('★ 增量状态存在 ref 里（不能靠 useMemo —— 它允许丢弃重算）', () => {
    expect(md).toContain('useRef<')
    expect(md).toContain('StableCache')
    expect(md).toContain('cache.current.text !== text')
    /* 查 import 行（注释里提到 useMemo 是正常的，那是在解释为什么不用它） */
    expect(md).toContain("import { memo, useRef } from 'react'")
  })

  it('★ 每个块包了 memo（稳定块才能跳过重渲染）', () => {
    expect(md).toContain('const Block = memo(function Block({ node }: { node: BlockNode })')
    expect(md).toContain('<Block key={index} node={node} />')
  })

  it('块的外层容器也要 memo，否则父组件重渲染会白跑一趟', () => {
    expect(md).toContain('export const Markdown = memo(function Markdown')
  })
})
