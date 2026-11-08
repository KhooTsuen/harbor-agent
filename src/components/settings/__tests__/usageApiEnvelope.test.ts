import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyQueryResult } from '@/lib/usageApi'

/* ══════════════════════════════════════════════════════════════
   `usage:query` 的信封解包（2026-11-09 真机逮到的真实故障）

   ── 病 ────────────────────────────────────────────────────────
   内核 `handlers/usage.cjs` 返回的是 `{ ok, result }` 信封，
   而 `lib/usageApi.ts` 把整个信封当成结果读 → `totals` 永远取不到，
   页面一直显示「内核没有返回用量数据」。

   最坏的地方不是白屏，是它**看起来像内核没实现**：真机上一度以为
   `usage:query` 根本没接上，实际只是包装层少剥了一层。

   ── 这一组怎么判 ──────────────────────────────────────────────
   直接给 `window.workbench.usageQuery` 塞信封，看包装层返回什么。
   三种情况必须分得开：
     · 成功信封  → ok:true，data 就是 result 本体
     · 失败信封  → ok:false 且**带内核给的原因**（不许改口说「没有记录」）
     · 成功但空壳 → ok:false（老内核没这个形状，不能当「零消耗」）
   ══════════════════════════════════════════════════════════════ */

/** 一份最小但形状完整的 result（字段与内核 `emptyBucket` 对齐） */
function resultWith(requests: number, known: number) {
  const base = emptyQueryResult()
  return {
    ...base,
    scanned: requests,
    matched: requests,
    totals: { ...base.totals, requests, known, unknown: requests - known },
  }
}

describe('usage:query 信封 / 包装层必须剥一层', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete (window as unknown as { workbench?: unknown }).workbench
    vi.resetModules()
  })

  it('★★★ 成功信封 {ok:true,result} → data 是 result 本体（不是信封）', async () => {
    const result = resultWith(7, 5)
    ;(window as unknown as { workbench: unknown }).workbench = {
      usageQuery: async () => ({ ok: true, result }),
    }
    const { usageQuery } = await import('@/lib/usageApi')
    const out = await usageQuery({})
    expect(out.ok).toBe(true)
    /* 这就是真机那个 bug 的判据：totals 必须拿得到 */
    expect(out.data.totals.requests).toBe(7)
    expect(out.data.totals.known).toBe(5)
    /* 信封本身的字段不许漏进 data（否则以后有人读 data.ok 会读到 undefined） */
    expect((out.data as unknown as { ok?: unknown }).ok).toBeUndefined()
  })

  it('★★★ 失败信封 → ok:false 且带内核原因（不能说成「没有记录」）', async () => {
    ;(window as unknown as { workbench: unknown }).workbench = {
      usageQuery: async () => ({ ok: false, error: '账本文件读不了' }),
    }
    const { usageQuery } = await import('@/lib/usageApi')
    const out = await usageQuery({})
    expect(out.ok).toBe(false)
    expect(out.error).toBe('账本文件读不了')
    /* 失败时给的是空结果，且它不是「零消耗」的证据 */
    expect(out.data.totals.requests).toBe(0)
  })

  it('★★ 成功但缺 result 形状（老内核）→ 算失败，不当成「零消耗」', async () => {
    ;(window as unknown as { workbench: unknown }).workbench = {
      usageQuery: async () => ({ ok: true }),
    }
    const { usageQuery } = await import('@/lib/usageApi')
    const out = await usageQuery({})
    expect(out.ok).toBe(false)
    expect(out.error).toContain('没有返回用量数据')
  })

  it('★★ 桥抛异常 → ok:false 且把原因带出来（不静默）', async () => {
    ;(window as unknown as { workbench: unknown }).workbench = {
      usageQuery: async () => {
        throw new Error('IPC 断了')
      },
    }
    const { usageQuery } = await import('@/lib/usageApi')
    const out = await usageQuery({})
    expect(out.ok).toBe(false)
    expect(out.error).toBe('IPC 断了')
  })

  it('★ 没有桥（浏览器预览）→ ok:false 且说明要桌面版', async () => {
    delete (window as unknown as { workbench?: unknown }).workbench
    const { usageQuery } = await import('@/lib/usageApi')
    const out = await usageQuery({})
    expect(out.ok).toBe(false)
    expect(out.error).toContain('桌面版')
  })
})

describe('usage:query 信封 / 三种天数状态仍然分得开', () => {
  it('★★★ 没调用 / 有调用但未知 / 已知，判据互斥', async () => {
    const { dayStateOf } = await import('@/lib/usageApi')
    const none = { ...emptyQueryResult().totals, requests: 0 }
    const partial = { ...emptyQueryResult().totals, requests: 3, known: 0, unknown: 3 }
    const mix = { ...emptyQueryResult().totals, requests: 3, known: 2, unknown: 1 }
    const zero = { ...emptyQueryResult().totals, requests: 2, known: 2, unknown: 0, total: 0 }
    const known = { ...emptyQueryResult().totals, requests: 2, known: 2, unknown: 0, total: 900 }

    expect(dayStateOf(none)).toBe('none')
    expect(dayStateOf(partial)).toBe('partial')
    expect(dayStateOf(mix)).toBe('partial')
    expect(dayStateOf(zero)).toBe('zero')
    expect(dayStateOf(known)).toBe('known')
  })
})
