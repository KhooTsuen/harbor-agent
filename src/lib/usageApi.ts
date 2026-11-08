import type {
  UsageQueryBucket,
  UsageQueryEnvelope,
  UsageQueryOptions,
  UsageQueryResult,
} from '@/types/usage-query'

/* ══════════════════════════════════════════════════════════════
    真实用量查询的桥包装

    ── 为什么单独一个文件 ────────────────────────────────────────
    `safetyApi` 已经 294 行、`extrasApi` 209 行，都贴着红线；而这一块的
    消费方只有一页（模型用量），语义也自成一体（真实账本口径）。

    ── 浏览器预览 ────────────────────────────────────────────────
    没有桥时返回**空结果**而不是抛异常 —— 页面要能正常显示「桌面版才有」，
    不是白屏。空结果的 `scanned/matched` 都是 0，所以界面不会误以为「有数据」。
    ══════════════════════════════════════════════════════════════ */

const bridge: { usageQuery?: (o?: UsageQueryOptions) => Promise<UsageQueryEnvelope> } | undefined =
  typeof window !== 'undefined'
    ? (
        window as unknown as {
          workbench?: { usageQuery?: (o?: UsageQueryOptions) => Promise<UsageQueryEnvelope> }
        }
      ).workbench
    : undefined

/** 空桶：所有数字 0、`cost` 为 null（与内核 `emptyBucket` 同形） */
export function emptyQueryBucket(): UsageQueryBucket {
  return {
    requests: 0,
    known: 0,
    unknown: 0,
    legacy: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheHit: 0,
    cacheMiss: 0,
    reasoning: 0,
    cost: null,
    errors: 0,
    aborted: 0,
    fieldUnavailable: {},
    coverage: null,
  }
}

/** 空结果（浏览器预览 / 桥缺失 / 查询失败都用它） */
export function emptyQueryResult(): UsageQueryResult {
  return {
    semantics: {
      promptIncludesCache: true,
      completionIncludesReasoning: true,
      timezone: 'local',
      costIsProviderReported: true,
      legacyHasNoKnownFlag: true,
    },
    scanned: 0,
    matched: 0,
    totals: emptyQueryBucket(),
    byProvider: {},
    byModel: {},
    byProviderModel: {},
    byPurpose: {},
    byEntry: {},
    byTask: {},
    bySession: {},
    byDay: {},
    days: [],
  }
}

export interface UsageQueryOutcome {
  /** 查询是否真的成功（false 时 `data` 是空结果，界面要显示「查询失败」而不是「没有记录」） */
  ok: boolean
  data: UsageQueryResult
  error?: string
}

/**
 * 查真实用量。
 *
 * ★ 失败与「没有记录」必须分开：查询挂了却显示「还没有记录」，用户会以为
 *   自己真的没花过 token。所以这里把 `ok` 单独带出来。
 */
export async function usageQuery(options?: UsageQueryOptions): Promise<UsageQueryOutcome> {
  if (!bridge?.usageQuery) {
    return { ok: false, data: emptyQueryResult(), error: '浏览器预览没有用量账本（请用桌面版）' }
  }
  try {
    /*
     * ★ 内核返回的是**信封** `{ ok, result }`（见 `handlers/usage.cjs`）。
     *   2026-11-09 真机逮到：这里以前把整个信封当结果读 → `totals` 永远取不到，
     *   页面一直显示「内核没有返回用量数据」，看着像内核压根没实现。
     */
    const reply = await bridge.usageQuery(options)
    if (!reply || typeof reply !== 'object') {
      return { ok: false, data: emptyQueryResult(), error: '内核没有返回用量数据' }
    }
    if (reply.ok !== true) {
      const reason =
        typeof (reply as { error?: unknown }).error === 'string'
          ? String((reply as { error: string }).error)
          : '内核报告查询失败'
      return { ok: false, data: emptyQueryResult(), error: reason }
    }
    const data = reply.result
    /* 信封说成功但里面没形状（老内核）→ 也算失败，别拿空壳当「没有记录」 */
    if (!data || typeof data !== 'object' || !data.totals) {
      return { ok: false, data: emptyQueryResult(), error: '内核没有返回用量数据' }
    }
    return { ok: true, data }
  } catch (error) {
    return {
      ok: false,
      data: emptyQueryResult(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 这个桶里有没有「确定发生过调用」（热力图与空态判断都用它，不看 token 数） */
export function hasCalls(bucket: UsageQueryBucket): boolean {
  return bucket.requests > 0
}

/**
 * 三种状态必须分开（热力图配色与图例的唯一判据）：
 *   · `none`     —— 一次都没调（`requests = 0`）
 *   · `zero`     —— 有调用，且**全部**拿到 usage 且合计为 0（服务商明确说是 0）
 *   · `partial`  —— 有调用，但部分或全部没拿到 usage（用量**未知**，不是 0）
 *   · `known`    —— 有调用，有真实 usage 且有非零消耗
 */
export type DayState = 'none' | 'zero' | 'partial' | 'known'

export function dayStateOf(day: UsageQueryBucket): DayState {
  if (day.requests === 0) return 'none'
  if (day.known === 0) return 'partial'
  if (day.unknown > 0) return 'partial'
  return day.total > 0 ? 'known' : 'zero'
}
