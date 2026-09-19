import { describe, expect, it } from 'vitest'
import { parseBlocks } from '@/lib/markdown'
import {
  EMPTY_CACHE,
  parseIncremental,
  splitPendingLine,
  type StableCache,
} from '@/lib/markdown/incremental'

/* ══════════════════════════════════════════════════════════════
   AG-022：流式时块结构不能反复横跳

   文档要求「不完整代码块稳定、表格布局稳定」。这里把「稳定」定义成一个
   可测的东西：**解析出的块类型序列（类型签名）在流式过程中变几次**。

   为什么会有横跳：模型一行一行吐，写到一半的那行往往是残缺的标记 ——
   `- `（空内容的列表项）、```t（围栏没写完）、`| A | B`（表格缺下一行
   的分割线）。拿它们去解析，类型就会来回改。

   修法是 `splitPendingLine`：**没换行收尾的那一行不进解析**，
   单独当纯文本渲染；等它写完整了再进解析。于是每种结构只变一次、单向。

   本文件对比的是「不拆」和「拆」两种情况，断言拆完之后不再横跳。
   ══════════════════════════════════════════════════════════════ */

function sig(blocks: { type: string }[]): string {
  return blocks.map((b) => b.type).join(',')
}

/** 逐字喂进去，数「类型签名变化」的次数；`split` 控制是否用新的拆分逻辑 */
function countFlips(text: string, chunk: number, split: boolean): number {
  let cache: StableCache = EMPTY_CACHE
  let prev = ''
  let flips = 0
  for (let i = 0; i <= text.length; i += chunk) {
    const r = parseIncremental(text.slice(0, i), cache)
    cache = r.cache
    const tail = split ? splitPendingLine(r.tailText).settled : r.tailText
    const now = sig([...cache.blocks, ...parseBlocks(tail)])
    if (prev && now !== prev) flips += 1
    prev = now
  }
  return flips
}

describe('AG-022 splitPendingLine', () => {
  it('没换行时整段都是「还在写」', () => {
    expect(splitPendingLine('- 甲')).toEqual({ settled: '', pending: '- 甲' })
  })

  it('有换行时最后一行是「还在写」', () => {
    expect(splitPendingLine('- 甲\n- ')).toEqual({ settled: '- 甲\n', pending: '- ' })
  })

  it('末尾正好是换行 → 没有「还在写」的部分', () => {
    expect(splitPendingLine('- 甲\n')).toEqual({ settled: '- 甲\n', pending: '' })
  })

  it('空串', () => {
    expect(splitPendingLine('')).toEqual({ settled: '', pending: '' })
  })
})

describe('AG-022 流式结构稳定性', () => {
  const CASES: Array<[string, string]> = [
    ['列表', '- 甲\n- 乙\n- 丙\n'],
    ['代码块', '```ts\nconst a = 1\nconst b = 2\n```\n'],
    ['表格', '| A | B |\n| --- | --- |\n| 1 | 2 |\n'],
    ['引用', '> 引一句\n> 接着引\n'],
    ['任务列表', '- [ ] 没做\n- [x] 做完\n'],
  ]

  for (const [name, text] of CASES) {
    it(`★ ${name}：拆了之后不再反复横跳`, () => {
      const raw = countFlips(text, 1, false)
      const split = countFlips(text, 1, true)
      console.info(`${name}: 不拆 ${raw} 次 → 拆了 ${split} 次`)
      /* 拆了之后最多只允许「一次成型」（比如段落→表格），不能来回改 */
      expect(split).toBeLessThanOrEqual(1)
      /* 而且不该比不拆更差 */
      expect(split).toBeLessThanOrEqual(raw)
    })
  }

  it('★ 列表这条最典型：不拆会横跳多次', () => {
    const raw = countFlips('- 甲\n- 乙\n- 丙\n', 1, false)
    /* 这是这条修复存在的理由 —— 如果哪天它不横跳了，说明解析器变了，回来重看 */
    expect(raw).toBeGreaterThan(1)
  })
})
