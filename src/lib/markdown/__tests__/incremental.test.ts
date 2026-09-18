import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks'
import { EMPTY_CACHE, findStablePoint, parseIncremental, type StableCache } from '../incremental'

/* ══════════════════════════════════════════════════════════════
   AG-021：增量解析的对拍

   这个文件的存在理由只有一个：**证伪**。

   增量解析的全部道理（「空行之后的块不会再变」）如果哪里想错了，
   后果不是「慢一点」，而是**渲染出错误的块**。所以不靠推理论证，
   而是拿一堆刁钻样本一步步模拟流式，每一步都对拍：

       增量结果  ===  parseBlocks(全文)

   任何一步不等，就说明切点找的位置不安全。

   ★ 对拍样本刻意挑「边界会被切错」的写法 —— 列表续行跨空行、
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

describe('AG-021 增量解析：与全文解析对拍', () => {
  for (const [name, text] of SAMPLES) {
    it(`${name} · 每次喂 1 个字`, () => {
      expect(streamCompare(text, 1).join('\n')).toBe('')
    })

    it(`${name} · 每次喂 3 个字（更接近真实批次）`, () => {
      expect(streamCompare(text, 3).join('\n')).toBe('')
    })
  }
})

describe('AG-021 增量解析：复用确实发生了', () => {
  it('★ 稳定前缀会被复用，不会重复解析', () => {
    const head = '# 标题\n\n第一段。\n\n第二段。\n\n'
    const cache: StableCache = parseIncremental(head, EMPTY_CACHE).cache
    const stable = cache.blocks.length
    expect(stable).toBeGreaterThan(1)

    /* 尾巴再长一段：稳定前缀那几块应该是同一批对象（引用相等） */
    const result = parseIncremental(`${head}第三段还在写`, cache)
    expect(result.reused).toBe(stable)
    for (let i = 0; i < stable; i += 1) {
      expect(result.blocks[i]).toBe(cache.blocks[i])
    }
    /* 新尾巴是新算的，总长一定变多 */
    expect(result.blocks.length).toBeGreaterThan(stable)
  })

  it('★ 只解析了尾巴，没有重解析全文', () => {
    /* 末尾那个空行之后还没有新内容，所以最后一段暂时算尾巴 —— 稳定块是 39 个 */
    const head = '段落。\n\n'.repeat(40)
    const cache: StableCache = parseIncremental(head, EMPTY_CACHE).cache

    const result = parseIncremental(`${head}新的一段还在长`, cache)
    /* 解析的字符数应该远小于全文长度 */
    expect(result.parsedChars).toBeLessThan(20)
    expect(result.reused).toBeGreaterThanOrEqual(39)
  })

  it('★ 文本被改写（不是追加）时退回全量，且结果正确', () => {
    let cache: StableCache = EMPTY_CACHE
    cache = parseIncremental('# 甲\n\n第一段\n\n', cache).cache

    /* 用户编辑：开头变了 —— 前缀校验必须拦下来 */
    const edited = '# 乙\n\n第一段\n\n第二段\n\n'
    const result = parseIncremental(edited, cache)
    expect(result.blocks).toEqual(parseBlocks(edited))
    expect(result.reused).toBe(0)
  })
})

describe('AG-021 findStablePoint：切点安全性', () => {
  it('普通空行后面顶格 → 是切点', () => {
    const text = '甲\n\n乙'
    expect(findStablePoint(text, 0, false).point).toBe(3)
  })

  it('★ 空行后面是缩进 → 不是切点（可能是列表续行）', () => {
    const text = '- 甲\n\n    - 深\n\n乙'
    const point = findStablePoint(text, 0, false).point
    /* 切点要么是 0，要么必须落在 `乙` 前面 —— 绝不能落在 `    - 深` 前面 */
    if (point !== 0) expect(text.slice(point).startsWith('    - 深')).toBe(false)
  })

  it('★ 围栏内的空行不是切点', () => {
    const text = '```\n甲\n\n乙\n```\n\n丙'
    const point = findStablePoint(text, 0, false).point
    /* 只有在围栏关闭之后的那个空行才允许当切点 */
    expect(text.slice(0, point).split('```').length % 2).toBe(1)
  })

  it('围栏未闭合 → 围栏之后的空行不当切点', () => {
    const text = '前言\n\n```ts\n甲\n\n乙\n\n丙'
    const point = findStablePoint(text, 0, false).point
    /* 围栏打开**之前**那个空行是安全的（`前言` 确实不会再变）——
       所以切点可以落在它后面。真正要守的是：**切点之前围栏必须配对**，
       不能切在一个已打开、还没关闭的围栏中间。 */
    expect(point).toBeGreaterThan(0)
    expect(point).toBeLessThanOrEqual(4)
    const fencesBefore = (text.slice(0, point).match(/```/g) || []).length
    expect(fencesBefore % 2).toBe(0)
  })
})
