import { describe, expect, it } from 'vitest'
import { parseBlocks } from '@/lib/markdown'
import { EMPTY_CACHE, parseIncremental, type StableCache } from '@/lib/markdown/incremental'

/* AG-021：全量解析 vs 增量解析，同一个流式场景。
   跑完删掉（或保留作 baseline 记录）——目的是拿到「改了多少」的数字。 */

function makeText(chars: number) {
  const chunk = [
    '## 小标题',
    '',
    '这是一段说明文字，包含 **粗体**、`行内代码` 和 [链接](https://example.com)。',
    '',
    '- 第一条',
    '- 第二条',
    '  - 嵌套一条',
    '',
    '```ts',
    'function hello(name: string) {',
    '  return `hi ${name}`',
    '}',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '结尾一段话。',
    '',
  ].join('\n')
  let out = ''
  while (out.length < chars) out += chunk
  return out.slice(0, chars)
}

function fullParseCost(text: string, batch: number) {
  let spent = 0
  for (let i = 0; i <= text.length; i += batch) {
    const cur = text.slice(0, i)
    const t0 = performance.now()
    parseBlocks(cur)
    spent += performance.now() - t0
  }
  return spent
}

function incrementalCost(text: string, batch: number) {
  let spent = 0
  let cache: StableCache = EMPTY_CACHE
  let chars = 0
  for (let i = 0; i <= text.length; i += batch) {
    const cur = text.slice(0, i)
    const t0 = performance.now()
    const r = parseIncremental(cur, cache)
    spent += performance.now() - t0
    cache = r.cache
    chars += r.parsedChars
  }
  return { spent, chars }
}

describe('AG-021 收益对比', () => {
  it('同一段流式，全量 vs 增量', () => {
    /* 只跑小尺寸：这是回归守卫，不是考古。20000 字那个量级留在
       tmp 里的历史记录（全量解析一次流式要 2~4 秒，会把测试拖慢）。 */
    for (const size of [1000, 5000]) {
      const text = makeText(size)
      const batch = 12
      const full = fullParseCost(text, batch)
      const inc = incrementalCost(text, batch)
      const fullChars = (text.length / batch) * (text.length / 2)
      console.info(
        `文本 ${String(size).padStart(6)} 字 · 全量 ${full.toFixed(1)} ms` +
          ` · 增量 ${inc.spent.toFixed(1)} ms（${((inc.spent / full) * 100).toFixed(0)}%）` +
          ` · 解析字符 ${(fullChars / 1000).toFixed(0)}k → ${(inc.chars / 1000).toFixed(1)}k` +
          `（${((inc.chars / fullChars) * 100).toFixed(1)}%）`,
      )

      /*
       * 回归守卫。阈值放得很松（只要比全量快一半、解析字符少一个量级）——
       * 这里要防的不是「慢了一点」，而是**增量机制整个失效了**
       * （比如有人把 Markdown 组件改回 parseBlocks，或者切点永远找不到）。
       */
      expect(inc.chars).toBeLessThan(fullChars / 5)
      expect(inc.spent).toBeLessThan(full / 2)
    }
  })
})
