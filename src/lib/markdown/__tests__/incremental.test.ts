import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks'
import { EMPTY_CACHE, findStablePoint, parseIncremental, type StableCache } from '../incremental'
import { splitPendingLine } from '../pending'

/* ══════════════════════════════════════════════════════════════
   增量解析的对拍

   这个文件的存在理由只有一个：**证伪**。

   增量解析的全部道理（「空行之后的块不会再变」）如果哪里想错了，
   后果不是「慢一点」，而是**渲染出错误的块**。所以不靠推理论证，
   而是拿一堆刁钻样本一步步模拟流式，每一步都对拍：

       增量结果  ===  parseBlocks(全文)

   任何一步不等，就说明切点找的位置不安全。

   ★ 样本刻意挑「边界会被切错」的写法 —— 列表续行跨空行、
     代码块里放空行、引用后接空行、表格、任务列表、围栏未闭合。
   ══════════════════════════════════════════════════════════════ */

const SAMPLES: Array<[string, string]> = [
  ['普通段落', '第一段。\n\n第二段。\n\n第三段。'],
  ['标题 + 段落', '## 标题\n\n正文一段。\n\n### 小标题\n\n又一段。'],
  ['无序列表', '- 甲\n- 乙\n\n- 丙'],
  ['★ 列表续行跨空行', '- 甲\n\n    - 深一层\n\n- 乙'],
  ['★ 列表项里放段落', '- 甲\n\n  甲的第二段\n\n- 乙'],
  ['★ 代码块里含空行', '前言\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n后记'],
  ['★ 围栏没闭合', '前言\n\n```ts\nconst a = 1\n\nconst b = 2\n'],
  ['引用', '> 引一句\n\n正文'],
  ['★ 引用懒续行', '> 引一句\n\n普通段落'],
  ['表格', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n后记'],
  ['任务列表', '- [x] 做完\n- [ ] 没做\n\n后记'],
  ['分隔线', '甲\n\n---\n\n乙'],
  ['嵌套引用', '> 一层\n>\n> > 二层\n\n正文'],
  [
    '混在一起',
    '## 头\n\n一段话。\n\n- 列表甲\n\n  续段\n\n```js\nx()\n```\n\n| A |\n| --- |\n| 1 |\n\n> 引用\n\n结尾。',
  ],
  ['★ 缩进代码块风格', '甲\n\n    indented code\n\n乙'],
]

/** 一步步喂进去，每一步都对拍 */
function streamCompare(text: string, step: number) {
  let cache: StableCache = EMPTY_CACHE
  const failures: string[] = []

  for (let i = 0; i <= text.length; i += step) {
    const current = text.slice(0, i)
    const result = parseIncremental(current, cache, (reason) => {
      failures.push(`i=${i} 失配回退：${reason}`)
    })
    cache = result.cache

    const expected = current ? parseBlocks(current) : []
    try {
      expect(result.blocks).toEqual(expected)
    } catch {
      failures.push(
        `i=${i} 块不一致\n  文本=${JSON.stringify(current)}\n  增量=${JSON.stringify(result.blocks)}\n  全量=${JSON.stringify(expected)}`,
      )
      break
    }
  }

  return failures
}

describe('增量解析：与全文解析对拍', () => {
  for (const [name, text] of SAMPLES) {
    it(`${name} · 每次喂 1 个字`, () => {
      expect(streamCompare(text, 1).join('\n')).toBe('')
    })

    it(`${name} · 每次喂 3 个字（更接近真实批次）`, () => {
      expect(streamCompare(text, 3).join('\n')).toBe('')
    })
  }

  it('★ 共享的 EMPTY_CACHE 不会被就地污染（它会被 push）', () => {
    parseIncremental('甲\n\n乙\n\n丙', EMPTY_CACHE)
    expect(EMPTY_CACHE.blocks).toEqual([])
    expect(EMPTY_CACHE.text).toBe('')
  })

  it('c 文本被改写（不是追加）→ 退回全量解析并标记 reset', () => {
    const first = parseIncremental('甲\n\n乙', EMPTY_CACHE)
    const rewritten = parseIncremental('丙\n\n丁', first.cache, () => {})
    expect(rewritten.reset).toBe(true)
    expect(rewritten.blocks).toEqual(parseBlocks('丙\n\n丁'))
  })

  it('稳定块的数组是**同一个**（push 追加，不造新数组）', () => {
    let cache: StableCache = EMPTY_CACHE
    const r1 = parseIncremental('甲\n\n乙\n\n丙', cache)
    cache = r1.cache
    const snapshot = cache.blocks
    const r2 = parseIncremental('甲\n\n乙\n\n丙\n\n丁', cache)
    expect(r2.cache.blocks).toBe(snapshot)
    expect(snapshot.length).toBeGreaterThan(1)
  })

  it('没有新切点时只重解析尾巴（稳定数组不追加）', () => {
    const first = parseIncremental('甲\n\n乙\n\n', EMPTY_CACHE)
    const stable = first.cache.blocks
    const more = parseIncremental('甲\n\n乙\n\n还在长', first.cache)
    expect(more.added).toEqual([])
    /* 尾巴 = 上次稳定切点之后的所有内容（这里含「乙」那一块） */
    expect(more.parsedChars).toBe('乙\n\n还在长'.length)
    /* 同一个数组：没有重建、也没追加 */
    expect(more.cache.blocks).toBe(stable)
    expect(more.reused).toBe(stable.length)
    expect(stable.length).toBe(1)
  })

  it('findStablePoint：围栏内的空行不算分界', () => {
    const text = '```\n甲\n\n乙\n```\n\n尾'
    const { point } = findStablePoint(text, 0, false)
    expect(text.slice(0, point)).toBe('```\n甲\n\n乙\n```\n\n')
  })
})

describe('半行策略（splitPendingLine）', () => {
  it('完整行照常解析（不留 pending）', () => {
    expect(splitPendingLine('## 标题').pending).toBe('')
    expect(splitPendingLine('- 甲').pending).toBe('')
    expect(splitPendingLine('一段文字。').pending).toBe('')
  })

  it('残缺标记降级成纯文本', () => {
    expect(splitPendingLine('- ').pending).toBe('- ')
    expect(splitPendingLine('```ts').pending).toBe('```ts')
    expect(splitPendingLine('## ').pending).toBe('## ')
    expect(splitPendingLine('| A').pending).toBe('| A')
    expect(splitPendingLine('|').pending).toBe('|')
    expect(splitPendingLine('> ').pending).toBe('> ')
  })

  it('★ 完整的表格行照常解析（不然流式时表格行永远长不进表格）', () => {
    expect(splitPendingLine('| A |').pending).toBe('')
    expect(splitPendingLine('| --- | --- |').pending).toBe('')
    expect(splitPendingLine('| 1 | 2 |').pending).toBe('')
    /* 表头 + 分隔线 + 数据行整段交给解析：与全文解析结果一致 */
    const text = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    expect(splitPendingLine(text).pending).toBe('')
    expect(parseBlocks(text)[0]?.type).toBe('table')
  })

  it('多行时只拆最后一行，前缀进 settled', () => {
    const { settled, pending } = splitPendingLine('## 标题\n正文\n- ')
    expect(settled).toBe('## 标题\n正文\n')
    expect(pending).toBe('- ')
  })
})
