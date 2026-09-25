import { describe, expect, it } from 'vitest'
import { ALL_GREETINGS, OPEN_GAP, greetingPool, pickGreeting } from '../greeting'

/* ══════════════════════════════════════════════════════════════
   开屏性格层：抽取规则（设计文档 §23）

   钉三件事：
     ① 分层：性格句不带状态（不声称完成过什么）—— 由文案库人工审过，
        这里钉「池子的选择规则」；
     ② 频率：同一句 ≥5 次开屏**或** ≥24 小时才能再来；
     ③ 场景：深夜只有深夜句；有阻断（normal=false）不出吐槽句。
   ══════════════════════════════════════════════════════════════ */

const at = (hour: number): Date => new Date(2026, 8, 26, hour, 30, 0)

describe('性格层 / 池子选择', () => {
  it('深夜（0-5 点）只从深夜句里挑', () => {
    const pool = greetingPool({ night: true, hasHistory: true, normal: true })
    expect(pool.length).toBeGreaterThan(0)
    expect(pool.every((g) => g.kind === 'night')).toBe(true)
  })

  it('没有历史 → 不出现回访句；有历史 → 可能出现', () => {
    const fresh = greetingPool({ night: false, hasHistory: false, normal: false })
    expect(fresh.some((g) => g.kind === 'revisit')).toBe(false)
    const back = greetingPool({ night: false, hasHistory: true, normal: false })
    expect(back.some((g) => g.kind === 'revisit')).toBe(true)
  })

  it('有阻断（normal=false）→ 吐槽句不参与（错误不许被玩笑盖住）', () => {
    const blocked = greetingPool({ night: false, hasHistory: true, normal: false })
    expect(blocked.some((g) => g.kind === 'quip')).toBe(false)
    const normal = greetingPool({ night: false, hasHistory: true, normal: true })
    expect(normal.some((g) => g.kind === 'quip')).toBe(true)
  })

  it('文案库每条都有内容、id 唯一（最多两行的小句子）', () => {
    const ids = new Set(ALL_GREETINGS.map((g) => g.id))
    expect(ids.size).toBe(ALL_GREETINGS.length)
    for (const g of ALL_GREETINGS) {
      expect(g.text.trim().length).toBeGreaterThan(2)
      expect(g.text.length).toBeLessThanOrEqual(30)
    }
  })
})

describe('性格层 / 频率规则', () => {
  it('刚用过的句子（<5 次开屏且 <24h）不会再被挑中', () => {
    const first = pickGreeting({
      now: at(14),
      hasHistory: false,
      normal: true,
      recent: [],
      opens: 1,
      rand: () => 0,
    })
    expect(first).not.toBeNull()
    /* 第 2..5 次开屏：同一句还差着间隔（opens 差 1..4 < 5）且时间不到 24h → 不能重样 */
    for (let step = 0; step < 4; step += 1) {
      const again = pickGreeting({
        now: at(14),
        hasHistory: false,
        normal: true,
        recent: [{ id: first!.id, at: at(14).getTime(), open: 1 }],
        opens: 2 + step,
        rand: () => 0,
      })
      expect(again?.id).not.toBe(first!.id)
    }
  })

  it('隔了 24 小时 → 旧句子可以再用（或规则的另一半成立）', () => {
    /* 把窗口内所有句子都标记成「1 次开屏前用的」，但时间已经是 2 天前：
       按「≥5 次或 ≥24h」的或规则，它们都重新可选 */
    const nextDay = new Date(at(14).getTime() + 2 * 24 * 3600 * 1000)
    const allUsed = ALL_GREETINGS.filter((g) => g.kind !== 'night').map((g) => ({
      id: g.id,
      at: at(14).getTime(),
      open: 1,
    }))
    const picked = pickGreeting({
      now: nextDay,
      hasHistory: false,
      normal: true,
      recent: allUsed,
      opens: 2,
      rand: () => 0.5,
    })
    expect(picked).not.toBeNull()
  })

  it('全部候选都被挡 → 返回 null（宁可不出，不破规矩）', () => {
    const pool = greetingPool({ night: false, hasHistory: false, normal: false })
    const recent = pool.map((g) => ({ id: g.id, at: at(14).getTime(), open: 20 }))
    const picked = pickGreeting({
      now: at(14),
      hasHistory: false,
      normal: false,
      recent,
      opens: 21,
    })
    expect(picked).toBeNull()
  })

  it('间隔常数就是 5（文档 §23.8 的硬数字）', () => {
    expect(OPEN_GAP).toBe(5)
  })
})
