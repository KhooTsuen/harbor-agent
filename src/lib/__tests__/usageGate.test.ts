import { describe, expect, it } from 'vitest'
import type { LimitsGateState } from '@/types/backend'
import { gateSummary } from '@/lib/usageGate'

/* ══════════════════════════════════════════════════════════════
   用量闸的措辞

   用户报的 bug：「关于用量限制，现在还是那种看似可用但实际无法正常使用的状态」。
   内核那边判定是对的，问题在**界面说不出它现在的真实状态** ——
   `enabled: true` + 上限 0 显示成一枚勾着的开关加两个空框，看着像在保护，
   实际一个请求都不拦。这里把「必须说出来的话」锁住。

   另外：**默认是不限**（`enabled: false`）。所以「没开」那一句必须是中性陈述，
   不能写成告警 —— 否则用户看到黄字会以为出了毛病，去查一个本来就没开的开关。
   ══════════════════════════════════════════════════════════════ */

function gate(patch: Partial<LimitsGateState> = {}): LimitsGateState {
  return {
    enabled: true,
    dailyTokens: 0,
    monthlyTokens: 0,
    onExceed: 'block',
    today: 0,
    month: 0,
    exceeded: false,
    level: null,
    idle: false,
    ...patch,
  }
}

const text = (g: Partial<LimitsGateState>) =>
  gateSummary(gate(g))
    .map((l) => l.text)
    .join(' | ')

describe('gateSummary', () => {
  it('老版本内核不带 gate → 一个字都不说（不瞎猜）', () => {
    expect(gateSummary(undefined)).toEqual([])
  })

  it('★ 开着但两个上限都是 0 → 明说「等于没设限」', () => {
    const lines = gateSummary(gate({ idle: true, today: 12_000, month: 34_000 }))
    expect(lines[0].status).toBe('warning')
    expect(lines[0].text).toContain('不限')
    expect(lines[0].text).toContain('没设限')
    /* 数字照样报出来 —— 在记，只是不拦 */
    expect(lines[1].text).toContain('12,000')
  })

  it('★ 默认（没开）就是不限，而且说法是**中性**的，不是告警', () => {
    const lines = gateSummary(gate({ enabled: false, dailyTokens: 100 }))
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('neutral')
    expect(lines[0].text).toContain('默认不限')
    /* 想设限自己去改 —— 提示里要指路 */
    expect(lines[0].text).toContain('开关')
    /* 不能写成「出事了」的口径：默认状态没有毛病 */
    expect(lines[0].text).not.toContain('拦不住')
  })

  it('★ 有上限时把「已用 / 上限 / 还剩」都说出来', () => {
    const t = text({ dailyTokens: 100_000, today: 30_000, month: 500_000 })
    expect(t).toContain('今天已用 30,000 / 上限 100,000')
    expect(t).toContain('还能用 70,000')
    /* 每月没设 → 如实说不限，而不是留空让人猜 */
    expect(t).toContain('每月不限')
  })

  it('用量接近上限时转成警告色（还剩 20% 以内）', () => {
    const lines = gateSummary(gate({ dailyTokens: 100_000, today: 85_000 }))
    expect(lines[0].status).toBe('warning')
  })

  it('已经超了 → 说清是「拦住」还是「只提示」', () => {
    const block = text({ dailyTokens: 100_000, today: 100_000, exceeded: true, level: 'day' })
    expect(block).toContain('已经超了')
    expect(block).toContain('会被拦住')

    const warn = text({
      dailyTokens: 100_000,
      today: 120_000,
      exceeded: true,
      level: 'day',
      onExceed: 'warn',
    })
    expect(warn).toContain('只会提示，不会拦')
  })

  it('超的是月限就说月限（别把日限的数字挂上去）', () => {
    const t = text({
      dailyTokens: 100_000,
      monthlyTokens: 200_000,
      today: 5_000,
      month: 200_000,
      exceeded: true,
      level: 'month',
    })
    expect(t).toContain('今天已用 5,000 / 上限 100,000')
    expect(t).toContain('本月已用 200,000 / 上限 200,000 —— 已经超了')
  })

  it('还剩多少不会算成负数', () => {
    const t = text({ dailyTokens: 100_000, today: 150_000 })
    expect(t).not.toContain('-')
  })
})
