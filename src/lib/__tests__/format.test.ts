import { describe, expect, it } from 'vitest'
import { formatCount, formatMoney, formatTokens } from '@/lib/format'

/* ══════════════════════════════════════════════════════════════
   金额格式化（A-展示 · 折算层）

   只钉**稳定**的东西（小数位数、兜底行为、含不含那个数），
   不钉 `Intl` 的**排版细节**（符号位置、空格）—— 那些随 node / ICU 版本会变，
   钉死了就是「换台机器红」的假失败。

   实测（node 24 / zh-CN）：
     ¥8.13 · ¥0.00 · ¥0.0004 · ¥1,234.50 · -¥3.20
   ══════════════════════════════════════════════════════════════ */

describe('formatMoney', () => {
  it('常规金额给两位小数', () => {
    expect(formatMoney(8.13)).toContain('8.13')
    expect(formatMoney(1234.5)).toContain('1,234.50')
  })

  it('★ 小额给 4 位小数（命中缓存的价极低，两位会一律显示 ¥0.00）', () => {
    /* 「每百万 0.02 元」下 2000 个 token 只有 0.00004 元 —— 两位小数看不出来 */
    const tiny = formatMoney(0.00042)
    expect(tiny).toContain('0.0004')
    expect(tiny).not.toContain('0.00 ')
  })

  it('★ 0 元是两位（「真的没花」不该显示成 0.0000）', () => {
    expect(formatMoney(0)).toContain('0.00')
  })

  it('恰好 0.01 元起回到两位', () => {
    expect(formatMoney(0.01)).toContain('0.01')
    expect(formatMoney(0.009)).toContain('0.0090')
  })

  it('负数照常格式化（不吞掉符号）', () => {
    const text = formatMoney(-3.2)
    expect(text).toContain('3.20')
    expect(text).toContain('-')
  })

  it('★ NaN / Infinity → 当 0（不许渲染出「¥NaN」）', () => {
    expect(formatMoney(NaN)).toContain('0.00')
    expect(formatMoney(NaN)).not.toContain('NaN')
    expect(formatMoney(Infinity)).not.toContain('Infinity')
  })

  it('货币代码可换（USD 出美元符号或代码）', () => {
    const usd = formatMoney(1.01, 'USD')
    expect(usd).toContain('1.01')
  })

  it('★ 货币代码非法不抛（config.json 是手填的，写错不该让面板白屏）', () => {
    expect(() => formatMoney(1, 'RMB')).not.toThrow()
    expect(formatMoney(1, '')).toContain('1.00')
    expect(() => formatMoney(1, '这不是货币码')).not.toThrow()
  })
})

describe('formatCount / formatTokens（原有行为别被这次改动带坏）', () => {
  it('完整数字带千位分隔', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(0)).toBe('0')
  })

  it('缩写只在小空间用', () => {
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatTokens(999)).toBe('999')
  })
})
