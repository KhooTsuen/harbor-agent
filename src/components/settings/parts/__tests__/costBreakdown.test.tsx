import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StatsSummary } from '@/types/backend'
import type { PricingConfig } from '@/types/pricing'
import { CostBreakdown, costLinesOf, moneyOfBucket } from '../CostBreakdown'

/* ══════════════════════════════════════════════════════════════
   花费构成（A-展示 · 第三批）

   这一节的**全部风险都在口径上**，不在渲染上。所以这里钉的是四句话：

     ① 「推理」**不是独立计费桶** —— 它是输出的子集，那一格不许出现金额；
     ② 查不到单价 → **一个金额都不许显示**（宁可少一行，也不给错数字）；
     ③ 「估算不是账单」必须**真的写在界面上**（不是只写在注释里）；
     ④ 输入未命中走 `prompt − cached`（不用 `cacheMiss`，它会漏行）。

   渲染用 `renderToStaticMarkup`（`react-dom/server`，**内置**）——
   项目里没有 `@testing-library/react`，也不许为测试引新依赖。
   连同 `processStyling.test.tsx` 是同一套写法。
   ══════════════════════════════════════════════════════════════ */

const bucket = (over: Record<string, number> = {}) => ({
  prompt: 0,
  completion: 0,
  total: 0,
  calls: 0,
  cached: 0,
  reasoning: 0,
  ...over,
})

const summary = (over: Partial<StatsSummary> = {}): StatsSummary => ({
  since: Date.now(),
  total: bucket(),
  days: [],
  models: [],
  file: '',
  ...over,
})

const PRICING: PricingConfig = {
  currency: 'CNY',
  unit: 'perMillionTokens',
  peakMode: 'offPeak',
  providers: {
    deepseek: {
      'deepseek-flash': {
        inMiss: { peak: 2, offPeak: 1 },
        inHit: { peak: 0.04, offPeak: 0.02 },
        out: { peak: 8, offPeak: 4 },
      },
    },
  },
}

const html = (data: StatsSummary, pricing: PricingConfig | null): string =>
  renderToStaticMarkup(<CostBreakdown data={data} pricing={pricing} />)

describe('CostBreakdown / 口径', () => {
  it('★ 推理那一格**不给金额**：它是输出的子集，再算一次就是重复计费', () => {
    const out = html(
      summary({
        total: bucket({
          prompt: 1_000_000,
          completion: 1_000_000,
          reasoning: 400_000,
          total: 2_000_000,
        }),
        models: [
          { ...bucket({ prompt: 1_000_000, completion: 1_000_000 }), model: 'deepseek-flash' },
        ],
      }),
      PRICING,
    )
    /* 四格都在 */
    expect(out).toContain('输入未命中（全价）')
    expect(out).toContain('输入命中（缓存）')
    expect(out).toContain('输出（含推理）')
    /* 「其中 · 推理」写明不单独计价；且推理 40 万 × 输出价会得到 ¥1.60 —— 那个数**不许出现** */
    expect(out).toContain('其中 · 推理')
    expect(out).toContain('属于输出的一部分，不单独计价')
    expect(out).not.toContain('¥1.60')
  })

  it('★ 单价查不到 → 一个金额都不显示，并写「未配置单价」', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 1_000_000, completion: 100, total: 1_000_100 }),
        /* 模型名不在价目表里 → priceOf 返回 null */
        models: [{ ...bucket({ prompt: 1_000_000, completion: 100 }), model: '某中转站的模型' }],
      }),
      PRICING,
    )
    expect(out).not.toContain('¥')
    expect(out).toContain('未配置单价')
  })

  it('★ 「估算不是账单」真的写在界面上（含法定节假日认账）', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 1_000_000, completion: 500, total: 1_000_500 }),
        models: [{ ...bucket({ prompt: 1_000_000, completion: 500 }), model: 'deepseek-flash' }],
      }),
      PRICING,
    )
    expect(out).toContain('不是账单')
    expect(out).toContain('法定节假日')
    expect(out).toContain('估算')
  })

  it('★ 「缓存 = 输入命中」说清是同一笔的两种计费，不是两个桶', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 10, cached: 5, completion: 1, total: 11 }),
        models: [{ ...bucket({ prompt: 10, cached: 5, completion: 1 }), model: 'deepseek-flash' }],
      }),
      PRICING,
    )
    expect(out).toContain('同一笔输入')
  })

  it('配好价时用到覆盖的模型 → 显示金额', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 }),
        models: [
          { ...bucket({ prompt: 1_000_000, completion: 1_000_000 }), model: 'deepseek-flash' },
        ],
      }),
      PRICING,
    )
    /* 空闲档：未命中 100 万 × 1 元 = ¥1.00；输出 100 万 × 4 元 = ¥4.00 */
    expect(out).toContain('¥1.00')
    expect(out).toContain('¥4.00')
  })

  it('★ 部分模型没配价 → 明说「金额里不含它们」，不假装是 0', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 2_000_000, total: 2_000_000 }),
        models: [
          { ...bucket({ prompt: 1_000_000 }), model: 'deepseek-flash' },
          { ...bucket({ prompt: 1_000_000 }), model: '没配价的模型' },
        ],
      }),
      PRICING,
    )
    expect(out).toContain('有 1 个模型没配单价')
  })

  it('★ 未命中用 `prompt − cached`（cacheMiss 会漏行，不许拿它当口径）', () => {
    const out = html(
      summary({
        /* cached 0.9M、prompt 1M → 未命中 0.1M；若误用 cacheMiss(=0) 会算成 1M */
        total: bucket({ prompt: 1_000_000, cached: 900_000, cacheMiss: 0, total: 1_000_000 }),
        models: [{ ...bucket({ prompt: 1_000_000, cached: 900_000 }), model: 'deepseek-flash' }],
      }),
      PRICING,
    )
    /* 未命中格 = 100,000（不是 cacheMiss 的 0，也不是整个 1,000,000）；
       占比 10% = 1 − 900,000/1,000,000（误用 cacheMiss 会变成 100%）；
       金额 = 0.1M × 1 元/M = ¥0.10 */
    expect(out).toContain('100,000')
    expect(out).toContain('未命中占 10%')
    expect(out).toContain('¥0.10')
  })

  it('没有数据（calls = 0）时不崩也不显示金额', () => {
    const out = html(summary(), null)
    expect(out).toContain('花费构成')
    expect(out).not.toContain('¥')
  })

  it('配置里钉死档位时，界面上说清「按哪一档估的」', () => {
    const out = html(
      summary({
        total: bucket({ prompt: 1_000_000, total: 1_000_000 }),
        models: [{ ...bucket({ prompt: 1_000_000 }), model: 'deepseek-flash' }],
      }),
      PRICING,
    )
    expect(out).toContain('空闲价')
    expect(out).toContain('钉死')
  })
})

describe('CostBreakdown / 单行折算（按模型 / 按天）', () => {
  it('★ 按模型那行给金额；查不到价的模型给 null（不猜）', () => {
    expect(moneyOfBucket(bucket({ prompt: 1_000_000 }), PRICING, 'deepseek-flash')).toBe('¥1.00')
    expect(moneyOfBucket(bucket({ prompt: 1_000_000 }), PRICING, '没配价的模型')).toBeNull()
    expect(moneyOfBucket(bucket({ prompt: 1_000_000 }), null, 'deepseek-flash')).toBeNull()
  })

  it('★ `costLinesOf` 跳过没配价的模型，并报出数量（金额里不含它们）', () => {
    const result = costLinesOf(
      [
        { ...bucket({ prompt: 1_000_000 }), model: 'deepseek-flash' },
        { ...bucket({ prompt: 1_000_000 }), model: '没配价的模型' },
      ],
      PRICING,
    )
    expect(result.unpriced).toBe(1)
    expect(result.lines?.inMiss).toBeCloseTo(1, 5) /* 只算配了价的那一个 */
  })

  it('一个都没配上价 → lines = null（整节退回「只显示 token」）', () => {
    const result = costLinesOf(
      [{ ...bucket({ prompt: 1_000_000 }), model: '某中转站的模型' }],
      PRICING,
    )
    expect(result.lines).toBeNull()
    expect(result.unpriced).toBe(1)
  })
})
