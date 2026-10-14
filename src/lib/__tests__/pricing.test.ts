import { describe, expect, it } from 'vitest'
import type { ModelPrice, PricingConfig } from '@/types/pricing'
import { estimateCost, isPeakTime, priceOf, tierOf } from '@/lib/pricing'

/* ══════════════════════════════════════════════════════════════
   花费折算（A-展示 · 折算层）

   这一组钉三件事：
     ① **不猜价** —— 查不到就 null（界面只显示 token，不显示金额）；
     ② **双档按当前时刻估**，且边界（12:00 整 / 18:00 整 / 周末）判对；
     ③ **推理不是独立桶** —— 折算只吃三项，`out` 已含推理。

   时刻用**固定日期**，不传 `new Date()` —— 否则测试在高峰时段和空闲时段
   跑出不同结果（那种「本地绿、换台机器红」的测试等于没有）。
   2026-10-15 是**周四**；下面注释里的时间都是**北京时间**，构造用 UTC 表达。
   ══════════════════════════════════════════════════════════════ */

/* 与内核默认价一致（electron/core/pricing-defaults.cjs）—— 手写一份是故意的：
   这里测的是**折算逻辑**，不是「默认值有没有被改」，两边不该互相绑架。 */
const flash: ModelPrice = {
  inMiss: { peak: 2, offPeak: 1 },
  inHit: { peak: 0.04, offPeak: 0.02 },
  out: { peak: 8, offPeak: 4 },
}
const pro: ModelPrice = {
  inMiss: { peak: 9, offPeak: 4.5 },
  inHit: { peak: 0.3, offPeak: 0.15 },
  out: { peak: 27, offPeak: 13.5 },
}

function pricing(patch: Partial<PricingConfig> = {}): PricingConfig {
  return {
    currency: 'CNY',
    unit: 'perMillionTokens',
    peakMode: 'auto',
    providers: { deepseek: { 'deepseek-flash': flash, 'deepseek-v4-pro': pro } },
    ...patch,
  }
}

/* 北京时间 → Date（UTC = 北京 − 8h） */
const bj = (iso: string) => new Date(`${iso}:00+08:00`)
const PEAK_AT = bj('2026-10-15T10:00') /* 周四上午，高峰 */
const OFF_AT = bj('2026-10-15T20:00') /* 周四晚上，空闲 */

describe('isPeakTime / 北京时间的档位边界', () => {
  it('工作日 09:00–12:00 与 14:00–18:00 是高峰', () => {
    expect(isPeakTime(bj('2026-10-15T09:00'))).toBe(true)
    expect(isPeakTime(bj('2026-10-15T10:30'))).toBe(true)
    expect(isPeakTime(bj('2026-10-15T14:00'))).toBe(true)
    expect(isPeakTime(bj('2026-10-15T17:59'))).toBe(true)
  })

  it('★ 区间**左闭右开**：12:00 整、18:00 整都算空闲', () => {
    expect(isPeakTime(bj('2026-10-15T12:00'))).toBe(false)
    expect(isPeakTime(bj('2026-10-15T18:00'))).toBe(false)
  })

  it('★ 两个高峰段之间的午休（12:00–14:00）是空闲', () => {
    expect(isPeakTime(bj('2026-10-15T13:00'))).toBe(false)
    expect(isPeakTime(bj('2026-10-15T08:59'))).toBe(false)
    expect(isPeakTime(bj('2026-10-15T23:00'))).toBe(false)
  })

  it('★ 周末全天是空闲（哪怕落在 9–12 的钟点上）', () => {
    expect(isPeakTime(bj('2026-10-17T10:00'))).toBe(false) /* 周六 */
    expect(isPeakTime(bj('2026-10-18T15:00'))).toBe(false) /* 周日 */
  })

  it('跟的是**北京时间**，不跟本机时区（官方按时区定价）', () => {
    /* 同一瞬间：北京时间 10:00 = UTC 02:00 —— 高峰（哪怕本机在 UTC 下跑） */
    expect(isPeakTime(new Date('2026-10-15T02:00:00Z'))).toBe(true)
    /* 北京时间 20:00 = UTC 12:00 —— 空闲 */
    expect(isPeakTime(new Date('2026-10-15T12:00:00Z'))).toBe(false)
  })
})

describe('tierOf / 档次怎么取', () => {
  it('peakMode 是 peak / offPeak 时**钉死**，不看时刻', () => {
    expect(tierOf(pricing({ peakMode: 'peak' }), OFF_AT)).toBe('peak')
    expect(tierOf(pricing({ peakMode: 'offPeak' }), PEAK_AT)).toBe('offPeak')
  })

  it('auto 跟随时刻', () => {
    expect(tierOf(pricing(), PEAK_AT)).toBe('peak')
    expect(tierOf(pricing(), OFF_AT)).toBe('offPeak')
  })

  it('配置缺失（pricing 为 null）时不抛，按 auto 处理', () => {
    expect(tierOf(null, PEAK_AT)).toBe('peak')
    expect(tierOf(null, OFF_AT)).toBe('offPeak')
  })
})

describe('priceOf / 三级匹配（查不到就 null，绝不猜）', () => {
  it('① 精确命中：providerId + model 都对上', () => {
    expect(priceOf(pricing(), 'deepseek', 'deepseek-flash')).toBe(flash)
    expect(priceOf(pricing(), 'deepseek', 'deepseek-v4-pro')).toBe(pro)
  })

  it('② 唯一命中：providerId 对不上（统计里 byModel 没有 providerId）', () => {
    expect(priceOf(pricing(), '', 'deepseek-flash')).toBe(flash)
    expect(priceOf(pricing(), undefined, 'deepseek-flash')).toBe(flash)
    expect(priceOf(pricing(), '别的供应商', 'deepseek-v4-pro')).toBe(pro)
  })

  it('③ 找不到 → null', () => {
    expect(priceOf(pricing(), 'deepseek', 'gpt-4o')).toBeNull()
    expect(priceOf(pricing(), '没这个供应商', '没这个模型')).toBeNull()
  })

  it('★ 同名模型出现在两个供应商下 → null（不挑一个编账单）', () => {
    const two = pricing({
      providers: { deepseek: { m: flash }, other: { m: pro } },
    })
    expect(priceOf(two, '', 'm')).toBeNull()
    expect(priceOf(two, 'deepseek', 'm')).toBe(flash) /* 精确给了就说清是谁的 */
  })

  it('★ 价不完整（缺项）→ null；精确命中不完整时**不回退到别家**', () => {
    const broken = {
      inMiss: { peak: 2, offPeak: 1 },
      inHit: { peak: 0.04, offPeak: 0.02 },
    } as unknown as ModelPrice
    const mixed = pricing({
      providers: { deepseek: { m: broken }, other: { m: pro } },
    })
    expect(priceOf(mixed, 'deepseek', 'm')).toBeNull() /* 精确命中但不完整 */
    /* 全库虽只有「一个完整」的价，但「声明了这个模型」的有两家 → 歧义 → null */
    expect(priceOf(mixed, '', 'm')).toBeNull()
  })

  it('★ 价里混了非数字（NaN / 字符串）也算不完整 → null', () => {
    const nan = { ...flash, out: { peak: NaN, offPeak: 4 } } as unknown as ModelPrice
    expect(priceOf(pricing({ providers: { deepseek: { m: nan } } }), 'deepseek', 'm')).toBeNull()
  })

  it('配置或模型名缺失 → null（不抛）', () => {
    expect(priceOf(null, 'deepseek', 'deepseek-flash')).toBeNull()
    expect(priceOf(undefined, 'deepseek', 'deepseek-flash')).toBeNull()
    expect(priceOf(pricing(), 'deepseek', '')).toBeNull()
    expect(priceOf(pricing(), 'deepseek', undefined)).toBeNull()
  })
})

describe('estimateCost / 双档折算（估算，不是账单）', () => {
  it('单位是「每百万 tokens」：100 万 × 2 元 = 2 元', () => {
    const cost = estimateCost(
      { inMiss: 1_000_000, inHit: 0, out: 0 },
      flash,
      pricing({ peakMode: 'peak' }),
    )
    expect(cost?.inMiss).toBeCloseTo(2, 10)
    expect(cost?.total).toBeCloseTo(2, 10)
  })

  it('★ 单档配置（peak === offPeak）下，两档**金额**一致（tier 仍如实报告用的哪一档）', () => {
    const flat: ModelPrice = {
      inMiss: { peak: 3, offPeak: 3 },
      inHit: { peak: 0.5, offPeak: 0.5 },
      out: { peak: 6, offPeak: 6 },
    }
    const tokens = { inMiss: 500_000, inHit: 200_000, out: 100_000 }
    const a = estimateCost(tokens, flat, pricing({ peakMode: 'peak' }))!
    const b = estimateCost(tokens, flat, pricing({ peakMode: 'offPeak' }))!
    /* 金额逐项比（浮点用 toBeCloseTo）；tier 不同是**对的** —— 它报告的是档次 */
    expect(a.inMiss).toBeCloseTo(b.inMiss, 10)
    expect(a.inHit).toBeCloseTo(b.inHit, 10)
    expect(a.out).toBeCloseTo(b.out, 10)
    expect(a.total).toBeCloseTo(b.total, 10)
    expect([a.tier, b.tier]).toEqual(['peak', 'offPeak'])
    expect(a.total).toBeCloseTo(1.5 + 0.1 + 0.6, 10)
  })

  it('★ 双档：peak 贵一倍（官方口径）', () => {
    const tokens = { inMiss: 1_000_000, inHit: 1_000_000, out: 1_000_000 }
    const peak = estimateCost(tokens, flash, pricing({ peakMode: 'peak' }))
    const off = estimateCost(tokens, flash, pricing({ peakMode: 'offPeak' }))
    expect(peak?.tier).toBe('peak')
    expect(off?.tier).toBe('offPeak')
    expect(peak?.total).toBeCloseTo(2 + 0.04 + 8, 10)
    expect(off?.total).toBeCloseTo(peak!.total / 2, 10) /* 空闲正好一半 */
  })

  it('★ auto 按**传进来的时刻**判档（可测：同一份 token，两时刻两个结果）', () => {
    const tokens = { inMiss: 1_000_000, inHit: 0, out: 0 }
    const atPeak = estimateCost(tokens, flash, pricing(), PEAK_AT)
    const atOff = estimateCost(tokens, flash, pricing(), OFF_AT)
    expect(atPeak?.tier).toBe('peak')
    expect(atPeak?.total).toBeCloseTo(2, 10)
    expect(atOff?.tier).toBe('offPeak')
    expect(atOff?.total).toBeCloseTo(1, 10)
  })

  it('★ 三项相加就是 total（没有别的桶混进来）', () => {
    const tokens = { inMiss: 300_000, inHit: 600_000, out: 100_000 }
    const cost = estimateCost(tokens, pro, pricing({ peakMode: 'peak' }))
    expect(cost!.total).toBeCloseTo(cost!.inMiss + cost!.inHit + cost!.out, 10)
  })

  it('★ 推理是**输出的一部分**，不单列一项、不重复计费', () => {
    const withThinking = { inMiss: 0, inHit: 0, out: 1_000_000 } /* 这 100 万全部是推理 */
    const cost = estimateCost(withThinking, flash, pricing({ peakMode: 'peak' }))
    expect(cost?.out).toBeCloseTo(8, 10) /* 只按 out 价算**一次** */
    expect(cost?.total).toBeCloseTo(8, 10)
    /* 返回形状里**没有** reasoning 这个桶 —— 加了就等于重复计费 */
    expect(Object.keys(cost!).sort()).toEqual(['inHit', 'inMiss', 'out', 'tier', 'total'])
  })

  it('token 缺字段 / 非数字 / 负数 → 当 0，不产生 NaN', () => {
    const cost = estimateCost({ inMiss: 0, inHit: 0, out: 0 }, flash, pricing())
    expect(cost?.total).toBe(0)
    const junk = estimateCost(
      { inMiss: NaN, inHit: -5, out: undefined } as unknown as {
        inMiss: number
        inHit: number
        out: number
      },
      flash,
      pricing(),
    )
    expect(Number.isNaN(junk!.total)).toBe(false)
    expect(junk!.total).toBe(0)
    expect(estimateCost(null, flash, pricing())?.total).toBe(0)
  })

  it('★ 价不完整 → null（不静默按 0 算 —— 「¥0.00」比不显示更误导）', () => {
    expect(estimateCost({ inMiss: 1, inHit: 0, out: 0 }, null)).toBeNull()
    const broken = { inMiss: { peak: 2, offPeak: 1 } } as unknown as ModelPrice
    expect(estimateCost({ inMiss: 1, inHit: 0, out: 0 }, broken)).toBeNull()
  })

  it('pricing 省略时按 auto 判档（不抛）', () => {
    const cost = estimateCost({ inMiss: 1_000_000, inHit: 0, out: 0 }, flash, undefined, PEAK_AT)
    expect(cost?.tier).toBe('peak')
  })
})
