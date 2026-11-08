import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
    第五阶段 · 聚合器的「三处一致」（性能优化的代价）

    ── 为什么要专门一条 ──────────────────────────────────────────
    `addInto` 为了命中率把 7 个字段**展开写**了（实测 150ms → 54ms）。
    代价是加新数值字段要同步三处：
       ① `NUMS`（决定 fieldUnavailable 有哪些键）
       ② `rowFacts`（从行里取值 + 判 null）
       ③ `addInto`（累进桶）
    漏一处的后果**不报错**：新字段要么永远不进合计，要么进了但
    fieldUnavailable 不计数 —— 界面上看起来正常，数字却是错的。

    ── 顺带钉住的两条 ────────────────────────────────────────────
      · 同步 `aggregate` 与异步 `aggregateAsync` 必须都走同一个 `buildResult`
        （否则分片版和其它版的数字会悄悄不一样）
      · 分片阈值必须真的在 `await`
    ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const QUERY = readFileSync(join(ROOT, 'electron/core/usage-query.cjs'), 'utf8')
const CORE = readFileSync(join(ROOT, 'electron/core/usage-bucket-core.cjs'), 'utf8')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('第五阶段 / 聚合器内部一致', () => {
  it('★★★ NUMS 与 addInto 里累加的字段完全一致（漏一个就静默算错）', () => {
    const numsMatch = /const NUMS = \[([^\]]+)\]/.exec(CORE)?.[1] ?? ''
    const nums = numsMatch
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean)

    const body = strip(CORE)
    const addStart = body.indexOf('function addInto')
    const addEnd = body.indexOf('function finish')
    const addBody = body.slice(addStart, addEnd)

    /* 每个 NUMS 字段都必须在这里出现「bucket.X += 」与「u.X += 1」两种写法 */
    for (const key of nums) {
      expect(addBody, `${key} 没有累加进 bucket`).toContain(`bucket.${key} +=`)
      expect(addBody, `${key} 没有计入 fieldUnavailable`).toContain(`u.${key} += 1`)
    }
  })

  it('★★★ rowFacts 为每个 NUMS 字段都产出扁平字段', () => {
    const numsMatch = /const NUMS = \[([^\]]+)\]/.exec(CORE)?.[1] ?? ''
    const nums = numsMatch
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean)
    const facts = strip(CORE).slice(strip(CORE).indexOf('function rowFacts'))
    for (const key of nums) {
      expect(facts, `rowFacts 缺 ${key}`).toContain(`${key}: known && Number.isFinite`)
    }
  })

  it('★★ 同步与异步聚合共用同一个 buildResult（口径只有一份）', () => {
    const q = strip(QUERY)
    expect(q).toContain('function buildResult')
    /* 两个入口都必须调它，而不是各自复制一份累加逻辑 */
    const builders = q.split('buildResult(').length - 1
    expect(builders, 'buildResult 至少被 3 处引用（定义 + 2 个调用）').toBeGreaterThanOrEqual(3)
    expect(q).not.toMatch(/function aggregateAsync[\s\S]*?out\.totals = emptyBucket/)
  })

  it('★★★ 异步分片真的在 await（否则等于没让出）', () => {
    const q = strip(QUERY)
    expect(q).toContain('setImmediate')
    expect(q).toContain('await yieldToLoop()')
    /* 分片阈值存在且被用来取模 */
    expect(q).toMatch(/const SLICE = \d+/)
    expect(q).toMatch(/% SLICE === 0/)
  })
})

describe('第五阶段 / 按天归日的时区口径', () => {
  it('★★★ 不按 UTC 除法切天（本地时区才算「今天」）', () => {
    const day = strip(readFileSync(join(ROOT, 'electron/core/usage-day.cjs'), 'utf8'))
    /* 必须走 setHours(0,0,0,0) 的本地零点 */
    expect(day).toContain('setHours(0, 0, 0, 0)')
    /* 不许出现「直接除 86400000 就当地序号」的写法 */
    expect(day).not.toMatch(/Math\.floor\(\s*ms\s*\/\s*DAY\s*\)/)
  })

  it('★★ 天序号 → 日期字符串仍与旧 dayKey 语义一致（今天能解析出来）', () => {
    const day = require('../../../../electron/core/usage-day.cjs') as {
      dayKey: (at: number) => string
      dayIndexOf: (at: number) => number
      labelOf: (i: number) => string
    }
    const now = Date.now()
    const label = day.dayKey(now)
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    /* 同一个时间戳两次得到的天号相同（缓存正确性） */
    expect(day.dayIndexOf(now)).toBe(day.dayIndexOf(now))
    /* 标签反解回去还是同一个天号 */
    expect(day.labelOf(day.dayIndexOf(now))).toBe(label)
  })
})
