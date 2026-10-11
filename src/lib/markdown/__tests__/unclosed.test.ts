import { describe, expect, it } from 'vitest'
import { parseBlocks } from '@/lib/markdown'
import { splitUnclosedBlock } from '../unclosed'

/* ══════════════════════════════════════════════════════════════
   未闭合跨行块降级（Phase 3 · Q3）

   要的语义：`$$` / 围栏**开着还没闭合**时整段当纯文本（流式期间别被吞进
   公式块 / 代码块再吐出来）；**闭合后**自然回归块渲染。

   这是纯函数，流式链的行为由它决定；`TailBlock` 只是调用方。
   ══════════════════════════════════════════════════════════════ */

describe('splitUnclosedBlock / 未闭合 $$', () => {
  it('未闭合 → 从 $$ 起整段算「未闭合」', () => {
    const { settled, unclosed } = splitUnclosedBlock('前文\n\n$$\nx + y')
    expect(settled).toBe('前文\n\n')
    expect(unclosed).toBe('$$\nx + y')
  })

  it('★ 闭合后 → 全部进入 settled（可以升级成块了）', () => {
    const { settled, unclosed } = splitUnclosedBlock('前文\n\n$$\nx + y\n$$')
    expect(unclosed).toBe('')
    expect(settled).toContain('$$')
    expect(parseBlocks(settled).some((b) => b.type === 'math')).toBe(true)
  })

  it('单行 `$$x$$` 不算未闭合（不能误判）', () => {
    const { unclosed } = splitUnclosedBlock('$$x^2$$')
    expect(unclosed).toBe('')
  })

  it('没有未闭合块时行为与改动前一致（全部 settled）', () => {
    const { settled, unclosed } = splitUnclosedBlock('普通一段话\n\n- 列表')
    expect(unclosed).toBe('')
    expect(settled).toBe('普通一段话\n\n- 列表')
  })
})

describe('splitUnclosedBlock / 未闭合围栏', () => {
  it('``` 开了没闭合 → 整段算未闭合', () => {
    const { settled, unclosed } = splitUnclosedBlock('说明\n\n```ts\nconst a = 1')
    expect(settled).toBe('说明\n\n')
    expect(unclosed).toBe('```ts\nconst a = 1')
  })

  it('~~~ 围栏同理', () => {
    const { unclosed } = splitUnclosedBlock('~~~\nx')
    expect(unclosed).toBe('~~~\nx')
  })

  it('★ 闭合后 → settled，能解析成 code', () => {
    const { settled, unclosed } = splitUnclosedBlock('```ts\nconst a = 1\n```')
    expect(unclosed).toBe('')
    expect(parseBlocks(settled).some((b) => b.type === 'code')).toBe(true)
  })

  it('未闭合围栏前面已闭合的块不受影响', () => {
    const { settled, unclosed } = splitUnclosedBlock('# 标题\n\n```\ncode')
    expect(parseBlocks(settled).map((b) => b.type)).toEqual(['heading'])
    expect(unclosed).toBe('```\ncode')
  })
})
