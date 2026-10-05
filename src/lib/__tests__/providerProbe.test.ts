import { describe, expect, it } from 'vitest'
import { probeConflicts } from '@/lib/providerProbeApi'
import type { ModelCapabilities, ModelProbeResult } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   「声明 vs 实测」对不上时怎么报

   这个功能的全部价值就在这条判断上：**声明说支持工具调用、实测不行，
   要当场说出来**（否则用户拿到的是一个「模型怪怪的」而不报错的现场）。

   两条必须守住的口径：
     · 实测 `null`（没测出来）**不算不一致** —— 未知不等于不支持；
     · 只报工具调用 / 图片两项 —— 流式慢一点是体验，不是错。
   ══════════════════════════════════════════════════════════════ */

const caps = (partial: Partial<ModelCapabilities>): ModelCapabilities =>
  ({ tool_call: null, vision: null, ...partial }) as ModelCapabilities

const probe = (results: ModelProbeResult['results']): ModelProbeResult => ({
  ok: true,
  at: Date.now(),
  providerId: 'p1',
  model: 'm1',
  results,
  notes: {},
})

describe('声明 vs 实测：只报会真让调用失败的不一致', () => {
  it('★ 声明说支持工具、实测不行 → 报出来', () => {
    const found = probeConflicts(caps({ tool_call: true }), probe({ tool_call: false }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('工具调用')
    expect(found[0]).toContain('实测不行')
  })

  it('★ 声明未知、实测不行 → 也报（用户至少知道它不行）', () => {
    const found = probeConflicts(caps({}), probe({ tool_call: false }))
    expect(found[0]).toContain('未知')
  })

  it('★ 实测是 null（没测出来）→ 不报（未知不等于不支持）', () => {
    expect(probeConflicts(caps({ tool_call: true }), probe({ tool_call: null }))).toEqual([])
  })

  it('两边都说支持 → 不报', () => {
    expect(probeConflicts(caps({ tool_call: true }), probe({ tool_call: true }))).toEqual([])
  })

  it('声明说不支持、实测能用 → 报（这条是好消息，也得说）', () => {
    const found = probeConflicts(caps({ vision: false }), probe({ vision: true }))
    expect(found[0]).toContain('实测可以用')
  })

  it('★ 流式不一致 / 实测没报的维度 → 不报（那是体验，不是错）', () => {
    expect(probeConflicts(caps({ streaming: true }), probe({ streaming: false }))).toEqual([])
    /* 声明里有 reasoning，而实测压根不测这一维 → 安静（没有不一致可言） */
    expect(probeConflicts(caps({ reasoning: true }), probe({}))).toEqual([])
  })

  it('没探测过 / 没声明 → 安静（不编）', () => {
    expect(probeConflicts(caps({ tool_call: true }), undefined)).toEqual([])
    expect(probeConflicts(undefined, probe({ tool_call: false }))).toEqual([])
  })
})
