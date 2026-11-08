import { describe, expect, it } from 'vitest'
import { bucketOf, hasAnyToken, totalsOf } from '../../../electron/core/usage-bucket.cjs'
import { knownTotalsOf } from '@/types/usage'

/* ══════════════════════════════════════════════════════════════
   真实 usage 归一（2026-11-09 查出的 bug 的守卫）

   ── 原来错在哪 ────────────────────────────────────────────────
   `llm.cjs:211` 拿的是服务商原始字段（`prompt_tokens` / `completion_tokens` /
   `prompt_cache_hit_tokens`），一路原样传到渲染层，而渲染层按 `UsageBucket`
   读（`prompt` / `completion` / `cached`）。中间只有一次 `as` 强转，
   TypeScript 没报错 —— **状态栏 token 数、ContextGauge 缓存命中永远是 0**。

   ── 这一组钉什么 ──────────────────────────────────────────────
   ① 两家方言都能转对（DeepSeek 用 hit/miss，OpenAI 用 details.cached_tokens）
   ② 「没上报」和「上报了 0」必须分开 —— 前者 null + known:false，后者 0
   ③ 只给部分字段时，缺的是 null，不补 0
   ④ 缓存含在 prompt 里（不许加起来翻倍）
   ══════════════════════════════════════════════════════════════ */

describe('usage 归一 / ① 两家方言', () => {
  it('★★ DeepSeek：hit/miss 分开取，cached = hit', () => {
    const b = bucketOf({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
    })
    expect(b.prompt).toBe(100)
    expect(b.completion).toBe(20)
    expect(b.total).toBe(120)
    expect(b.cached).toBe(60)
    expect(b.cacheMiss).toBe(40)
    expect(b.source).toBe('deepseek-style')
    expect(b.known).toBe(true)
  })

  it('★★ OpenAI：cached 从 prompt_tokens_details 取，没有 miss', () => {
    const b = bucketOf({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60 },
    })
    expect(b.cached).toBe(60)
    expect(b.cacheMiss).toBeNull()
    expect(b.source).toBe('openai-style')
  })

  it('★★ 缓存**含在** prompt 里：prompt 不许被加上缓存', () => {
    const b = bucketOf({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 })
    expect(b.prompt).toBe(100)
    /* 加错的话这里会是 160 */
    expect(b.prompt).not.toBe(160)
  })
})

describe('usage 归一 / ② 未知 ≠ 0（这一组的核心）', () => {
  it('★★★ 明确上报 0 → 三个数都是 0，known 为真', () => {
    const b = bucketOf({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
    expect(b.known).toBe(true)
    expect(b.prompt).toBe(0)
    expect(b.completion).toBe(0)
    expect(b.total).toBe(0)
  })

  it('★★★ 完全没给 usage → 返回 null（不是一堆 0）', () => {
    expect(bucketOf(null)).toBeNull()
    expect(bucketOf(undefined)).toBeNull()
  })

  it('★★★ 给了个空对象 → known 为假、数字是 null', () => {
    const b = bucketOf({})
    expect(b.known).toBe(false)
    expect(b.prompt).toBeNull()
    expect(b.completion).toBeNull()
    expect(b.total).toBeNull()
  })

  it('★★ 两者的区别能被下游看到（knownTotalsOf 的契约）', () => {
    const zero = totalsOf(bucketOf({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }))
    const unknown = totalsOf(bucketOf({}))
    expect(zero.known).toBe(true)
    expect(unknown.known).toBe(false)
    /* 都算出来是 0 —— 但 known 不同，界面据此显示「0」还是「无数据」 */
    expect(zero.total).toBe(0)
    expect(unknown.total).toBe(0)
  })
})

describe('usage 归一 / ③ 只给部分字段（缺的补 null 不补 0）', () => {
  it('★★ 只有 prompt → completion 是 null，total 也推不出来', () => {
    const b = bucketOf({ prompt_tokens: 100 })
    expect(b.prompt).toBe(100)
    expect(b.completion).toBeNull()
    /* ★ total 不能拍脑袋等于 prompt —— 那样会把输入当成总消耗 */
    expect(b.total).toBeNull()
  })

  it('★★ prompt + completion 都有、没给 total → 算出来', () => {
    const b = bucketOf({ prompt_tokens: 100, completion_tokens: 20 })
    expect(b.total).toBe(120)
  })

  it('★ 思考 token 从 completion_tokens_details 取（属于 completion）', () => {
    const b = bucketOf({
      prompt_tokens: 10,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
    })
    expect(b.reasoning).toBe(30)
    /* 属于 completion，不是并列 */
    expect(b.completion).toBe(50)
  })
})

describe('usage 归一 / ④ 辅助函数', () => {
  it('★ hasAnyToken 认得出三种情况', () => {
    expect(hasAnyToken({ prompt_tokens: 1 })).toBe(true)
    expect(hasAnyToken({ prompt_tokens: 0 })).toBe(true)
    expect(hasAnyToken({})).toBe(false)
    expect(hasAnyToken(null)).toBe(false)
  })

  it('★ 原始对象原样带回去（以后要查「这家到底返了什么」）', () => {
    const raw = { prompt_tokens: 1, completion_tokens: 2 }
    expect(bucketOf(raw).raw).toBe(raw)
  })
})

describe('usage 归一 / ⑤ 「没发过请求」不等于「请求了但没上报」', () => {
  /*
   * 2026-11-09 真机逮到：只发过一条 hello、还没收到回复时，ContextGauge 的
   * tooltip 写「另有 1 次请求没有用量上报」—— 那条其实是**用户消息**，
   * 根本没发过模型请求。原因是 knownTotalsOf 把「没有 usage 字段」也当成
   * unknown +1。两者必须分开：
   *   · usage === undefined  → 没发过请求（requests 0 / unknown 0）
   *   · usage.known === false → 发了但没上报（unknown 1）
   */
  it('★★★ 没有 usage 字段 → 不计入任何一边（以前会算成「1 次未上报」）', () => {
    const t = knownTotalsOf(undefined)
    expect(t.requests).toBe(0)
    expect(t.unknown).toBe(0)
    expect(t.total).toBe(0)
  })

  it('★★★ 有 usage 但 known:false → 才算「未知 1 次」', () => {
    const t = knownTotalsOf(bucketOf({}))
    expect(t.requests).toBe(0)
    expect(t.unknown).toBe(1)
  })

  it('★★ 有真实 usage → requests 1 / unknown 0', () => {
    const t = knownTotalsOf(bucketOf({ prompt_tokens: 100, completion_tokens: 20 }))
    expect(t.requests).toBe(1)
    expect(t.unknown).toBe(0)
    expect(t.total).toBe(120)
  })

  it('★ 一条用户消息 + 一条无上报回复 → 只算 1 次未知', () => {
    const sum = [undefined, bucketOf({})].reduce(
      (acc, u) => {
        const one = knownTotalsOf(u)
        return { requests: acc.requests + one.requests, unknown: acc.unknown + one.unknown }
      },
      { requests: 0, unknown: 0 },
    )
    expect(sum.unknown).toBe(1)
  })
})
