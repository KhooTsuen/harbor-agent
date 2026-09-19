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
/* 渲染块的实现从 Markdown.tsx 拆到了 markdown/Blocks.tsx（文件超 300 行拆的） */
const blocks = readFileSync(join(ROOT, 'src/components/chat/markdown/Blocks.tsx'), 'utf8')

describe('AG-021/022 接线守卫', () => {
  it('★ 流式中走增量解析，写完的消息整篇解析', () => {
    expect(md).toContain('parseIncremental(text, cache.current.stable)')
    /* 写完的消息不能用「拆最后一行」那套 —— 表格的数据行离开表头就不是表格了 */
    expect(md).toContain('useMemo(() => (streaming ? null : parseBlocks(text)), [streaming, text])')
    expect(md).not.toContain('parseBlocks(text)\n')
  })

  it('★ 增量状态存在 ref 里（不能靠 useMemo —— 它允许丢弃重算）', () => {
    expect(md).toContain('useRef<')
    expect(md).toContain('StableCache')
    expect(md).toContain('cache.current.text !== text')
    /* 查 import 行（注释里提到 useMemo 是正常的，那是在解释为什么不用它） */
    expect(md).toContain("import { memo, useMemo, useRef, type ReactNode } from 'react'")
  })

  it('★★ 稳定块缓存的是 React 元素对象（不是数据）', () => {
    /*
     * 这是 AG-022 的核心。只有缓存元素对象，React 才能在
     * `oldElement === newElement` 时直接 bailout。
     * 若改回「每次 map 出元素」，就退回 4ms/次（实测数据见 Markdown.tsx 注释）。
     */
    expect(md).toContain('elements: ReactNode[]')
    expect(md).toContain('cache.current.elements.push(')
    expect(md).toContain('<CachedBlocks elements={elements} />')
  })

  it('★ 缓存元素的数组必须「只增不改」（push），不能每轮重建', () => {
    expect(md).toContain('cache.current.elements = []') // 只在 reset 时重建
    expect(md).not.toContain('cache.current = { text, stable: result.cache, elements: []')
  })

  it('★ 每个块包了 memo（稳定块才能跳过组件调用）', () => {
    expect(blocks).toContain(
      'export const Block = memo(function Block({ node }: { node: BlockNode })',
    )
    expect(md).toContain('<Block key=')
  })

  it('★ 流式中尾巴里那半行不进解析（AG-022 修横跳的关键）', () => {
    expect(blocks).toContain('const { settled, pending } = splitPendingLine(text)')
    /* 流式时 pending 当纯文本；写完了才解析它 */
    expect(md).toContain('<TailBlock text={tailText} streaming />')
    expect(blocks).toContain('streaming ? (')
  })
})
