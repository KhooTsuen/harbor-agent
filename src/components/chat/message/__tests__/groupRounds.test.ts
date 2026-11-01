import { describe, expect, it } from 'vitest'
import type { MessageRound, ToolRunRecord } from '@/types'
import { groupRounds, isFoldableRound, isProcessSpeech, lastBodyIndex } from '../groupRounds'

/* ══════════════════════════════════════════════════════════════
   跨轮同类聚合（Phase 3）

   用户对这块的硬要求：**强制打断规则必须用单测钉死** ——
   「只要连续的工具轮次里出现了一个 `run.ok === false`，或者夹杂了
   clarify 卡片，聚合必须立刻断开。宁可多出几张卡片，也绝对不能把
   『失败』和『成功』折叠进同一个卡片里」。

   所以这里逐条钉：失败 / 还在跑（等确认）/ 子代理 / 出现正文 / clarifying。
   ══════════════════════════════════════════════════════════════ */

const run = (over: Partial<ToolRunRecord> = {}): ToolRunRecord => ({
  id: Math.random().toString(36).slice(2),
  name: 'read_file',
  ok: true,
  output: '内容',
  ms: 5,
  ...over,
})

/** 造一轮纯工具轮：`tools` 是下标，默认一轮一个工具 */
const round = (tools: number[], over: Partial<MessageRound> = {}): MessageRound => ({
  reasoning: '',
  content: '',
  tools,
  ...over,
})

describe('groupRounds / 正常聚合', () => {
  it('连续 6 轮同类工具 → 折成 1 组，明细一条不少', () => {
    const runs = Array.from({ length: 6 }, (_, i) => run({ summary: `note-${i}.md` }))
    const rounds = [round([0]), round([1]), round([2]), round([3]), round([4]), round([5])]

    const items = groupRounds(rounds, runs)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('group')
    if (items[0].kind !== 'group') return
    expect(items[0].from).toBe(0)
    expect(items[0].to).toBe(5)
    /* 展开后仍是 6 条原始明细 —— 聚合只改「怎么显示」，不改「有多少」 */
    expect(items[0].runs).toHaveLength(6)
  })

  it('单轮不聚合（没得折，保持原样）', () => {
    const items = groupRounds([round([0])], [run()])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('round')
  })

  it('一轮带多个工具也照常折', () => {
    const items = groupRounds([round([0, 1]), round([2])], [run(), run(), run()])
    expect(items).toHaveLength(1)
    if (items[0].kind !== 'group') throw new Error('应当是 group')
    expect(items[0].runs).toHaveLength(3)
  })
})

describe('groupRounds / 强制打断（钉死）', () => {
  it('★ 中间夹一个失败 → 断成 前组 + 失败轮 + 后组（不与成功同卡）', () => {
    const runs = [run(), run(), run({ ok: false, ms: 12 }), run(), run()]
    const rounds = [round([0]), round([1]), round([2]), round([3]), round([4])]

    const items = groupRounds(rounds, runs)
    expect(items.map((i) => i.kind)).toEqual(['group', 'round', 'group'])
    /* 失败那一轮必须**单独**成项，且它的 run 不在任何 group 里 */
    const middle = items[1]
    if (middle.kind !== 'round') throw new Error('中间应当是独立轮')
    expect(middle.round.tools).toEqual([2])
    for (const item of items) {
      if (item.kind === 'group') expect(item.runs.some((r) => !r.ok)).toBe(false)
    }
  })

  it('★ 还在跑（等确认 / 等权限）也打断：ok!==true 一律不算「确定成功」', () => {
    const runs = [run(), run({ ok: false, ms: undefined }), run()]
    const items = groupRounds([round([0]), round([1]), round([2])], runs)
    expect(items.map((i) => i.kind)).toEqual(['round', 'round', 'round'])
  })

  it('★ 出现正文 → 立刻打断（正文不能被折叠吞掉）', () => {
    const runs = [run(), run(), run()]
    const rounds = [round([0]), round([1], { content: '这是一段回答' }), round([2])]
    const items = groupRounds(rounds, runs)
    expect(items.map((i) => i.kind)).toEqual(['round', 'round', 'round'])
  })

  it('★ 子代理卡 → 打断（它始终单独显示，不被折叠）', () => {
    const runs = [run(), run({ name: 'spawn_subagent', subagent: {} as never }), run()]
    const items = groupRounds([round([0]), round([1]), round([2])], runs)
    expect(items.map((i) => i.kind)).toEqual(['round', 'round', 'round'])
  })

  it('★ 有澄清卡 → 整条不跨轮聚合（问之前 / 之后的轮不混在一起）', () => {
    const runs = [run(), run(), run(), run()]
    const rounds = [round([0]), round([1]), round([2]), round([3])]
    const items = groupRounds(rounds, runs, { clarify: true })
    expect(items.every((i) => i.kind === 'round')).toBe(true)
    expect(items).toHaveLength(4)
  })

  it('空轮（没有工具）不进组', () => {
    const runs = [run(), run()]
    const items = groupRounds([round([]), round([0]), round([1])], runs)
    expect(items[0].kind).toBe('round')
  })

  it('isFoldableRound 直接说的就是这几条', () => {
    expect(isFoldableRound(round([0]), [run()])).toBe(true)
    expect(isFoldableRound(round([0]), [run({ ok: false })])).toBe(false)
    expect(isFoldableRound(round([0]), [run({ subagent: {} as never })])).toBe(false)
    expect(isFoldableRound(round([0], { content: 'x' }), [run()])).toBe(false)
    expect(isFoldableRound(round([]), [])).toBe(false)
  })
})

describe('groupRounds / 越界与健壮', () => {
  it('tools 下标越界（落盘/读回不一致）不崩 —— 当作没这轮工具', () => {
    const items = groupRounds([round([9]), round([10])], [run()])
    /* 两轮都取不到 run → 不可聚合 → 各自独立，且不抛错 */
    expect(items.every((i) => i.kind === 'round')).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════
   「过程话」归属（2026-10-21 用户拍板）

   用截图里那种真实形状钉：`先说一句 → 调工具 → 再说一句 → 再调工具 → 结论`。
   判据只有一条结构：**有工具 + 有正文 + 不是最后一段正文**。
   ══════════════════════════════════════════════════════════════ */

describe('isProcessSpeech / 哪段正文算过程话', () => {
  /* 截图那条的形状：两句铺垫 + 一句结论 */
  const real: MessageRound[] = [
    round([0], { content: '我先核对磁盘上的实际状态，不要只凭任务台账汇报。' }),
    round([1]),
    round([2], { content: '现在状态核完了。代码层面已经基本做完，只剩真机那一步。' }),
    round([3]),
    round([4], { content: '## 结论\n\n三版都同步完了。' }),
  ]

  it('★★★ 有工具 + 不是最后一段正文 → 算过程话（截图那两句）', () => {
    expect(isProcessSpeech(real, 0)).toBe(true)
    expect(isProcessSpeech(real, 2)).toBe(true)
  })

  it('★★★ 最后一段正文永远是正文（那是结论）', () => {
    expect(isProcessSpeech(real, 4)).toBe(false)
    expect(lastBodyIndex(real)).toBe(4)
  })

  it('★★ 没调工具的那轮正文照旧是正文（纯说一句不算过程）', () => {
    const rounds = [round([], { content: '先说一句' }), round([0]), round([], { content: '结论' })]
    expect(isProcessSpeech(rounds, 0)).toBe(false)
  })

  it('★★ 只有一段正文时永远是正文（老记录合成的一轮走的就是这条）', () => {
    const rounds = [round([0], { content: '过程 + 结论都在这一轮' })]
    expect(isProcessSpeech(rounds, 0)).toBe(false)
    expect(lastBodyIndex(rounds)).toBe(0)
  })

  it('★ 一条正文都没有 → lastBodyIndex 是 -1，且谁都不算过程话', () => {
    const rounds = [round([0]), round([1])]
    expect(lastBodyIndex(rounds)).toBe(-1)
    expect(isProcessSpeech(rounds, 0)).toBe(false)
  })

  it('★ 空白正文不算正文（不会被当成结论挡住前面的过程话）', () => {
    const rounds = [round([0], { content: '铺垫' }), round([1], { content: '   ' })]
    expect(lastBodyIndex(rounds)).toBe(0)
    expect(isProcessSpeech(rounds, 0)).toBe(false)
  })
})
