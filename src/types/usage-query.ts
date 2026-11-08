/* ══════════════════════════════════════════════════════════════
    真实用量查询（`usage:query`）的返回形状 —— 内核唯一真相源
    `electron/core/usage-query.cjs`

    ── 这个文件和 `stats.ts` 的 `UsageBucket` 不是一回事 ──────────
      · `UsageBucket`（stats.ts）= **旧累计桶**：老统计页把一堆请求加起来，
        字段全是 `number`，老记录按 0 补。它回答「一共花了多少」，
        但**分不清「没上报」和「确实是 0」**。
      · 这里 = **新账本口径**：额外带 `known` / `unknown` / `legacy` /
        `fieldUnavailable`，所以界面能说清「这个数是多少，覆盖了多少请求，
        哪些字段没有」。

    ── 三条不能破的口径（内核那边写死，界面只照着显示）──────────
      1. `known` 才进 token 合计；`unknown` 只进计数，**一个 token 都不加**。
      2. `cost` 只在服务商真给了金额时才是数字，否则 `null`（不是 0 元）。
      3. `prompt` 已含 `cacheHit`（DeepSeek 的 hit+miss=prompt，OpenAI 的
         cached 是 prompt 子集）→ 界面**绝不再加一遍**。
    ══════════════════════════════════════════════════════════════ */

/** 一个维度上的聚合桶（每个字段都可能因为「没上报」而偏小 —— 看 `fieldUnavailable`） */
export interface UsageQueryBucket {
  /** 落在这个桶里的账本行数（= 请求次数，含失败与中止） */
  requests: number
  /** 拿到真实 usage 的请求数 */
  known: number
  /** 没拿到 usage 的请求数（失败 / 中止 / 这家中转不给）—— **不是 0 消耗** */
  unknown: number
  /** 老记录数（没有 `known` 字段的那批）：数值照算，但单独标出来 */
  legacy: number
  prompt: number
  completion: number
  total: number
  /** 缓存命中 token（**含在 prompt 内**） */
  cacheHit: number
  /** 缓存未命中（只有 DeepSeek 给） */
  cacheMiss: number
  /** 思考 token（**含在 completion 内**） */
  reasoning: number
  /** 服务商真返回的金额；一次都没给 → `null`（不是 0 元） */
  cost: number | null
  errors: number
  aborted: number
  /**
   * 每个数值字段「有多少行没给」。
   * 用来区分「确实是 0」和「压根没上报」—— 这是这一层存在的理由。
   */
  fieldUnavailable: Record<string, number>
  /** `known / requests`，没有请求时为 `null` */
  coverage?: number | null
}

/** 某一天（热力图一格） */
export interface UsageQueryDay extends UsageQueryBucket {
  day: string
  /**
   * `true` = 这天**一次都没调用**（`requests: 0`，不含任何 token 数字）。
   * 不设这个标志 = 有调用（可能全部未知用量，那时看 `known/unknown`）。
   */
  empty?: boolean
}

export interface UsageQueryResult {
  /** 口径声明（缓存是否含在输入里、时区、cost 是否服务商上报） */
  semantics: {
    promptIncludesCache: boolean
    completionIncludesReasoning: boolean
    timezone: string
    costIsProviderReported: boolean
    legacyHasNoKnownFlag: boolean
  }
  /** 账本总行数（不受筛选影响） */
  scanned: number
  /** 命中筛选的行数 */
  matched: number
  totals: UsageQueryBucket
  byProvider: Record<string, UsageQueryBucket>
  byModel: Record<string, UsageQueryBucket>
  /** key = `供应商\u0000模型` —— 同名模型分属两家时靠它区分 */
  byProviderModel: Record<string, UsageQueryBucket & { providerId: string; model: string }>
  /** key = 调用类别（chat / summary / compact / scene / vision / prewarm / collab），空 = （未标注） */
  byPurpose: Record<string, UsageQueryBucket>
  byEntry: Record<string, UsageQueryBucket>
  /** key = taskId，空归属进「（未归属）」—— 不按时间接近去猜 */
  byTask: Record<string, UsageQueryBucket>
  bySession: Record<string, UsageQueryBucket>
  byDay: Record<string, UsageQueryBucket>
  /** 按天升序；只有 `includeEmptyDays` 时才补齐空白日 */
  days: UsageQueryDay[]
  /** 账本体检（只报能确证的四类；`checked` 列出真跑过的检查） */
  anomalies?: UsageAnomalies
  /** 原始行（只在 `withRows: true` 时出现，数据量大不要默认要） */
  rows?: Array<Record<string, unknown>>
}

/** 查询条件（与 `handlers/usage.cjs` 的白名单一一对应） */
export interface UsageQueryOptions {
  from?: number
  to?: number
  providerId?: string
  model?: string
  taskId?: string
  sessionId?: string
  entry?: 'api' | 'cli'
  purpose?: string
  /** 补齐没有调用的空白天（热力图要能区分「没调用」和「有调用但未知」） */
  includeEmptyDays?: boolean
  /** 附带原始行（诊断用；几千行以上别要） */
  withRows?: boolean
}

/**
 * `usage:query` 的 IPC 信封
 *
 * ★ 内核（`handlers/usage.cjs`）返回的是 `{ ok, result }`，**不是**裸的结果。
 *   2026-11-09 真机逮到：桥包装把整个信封当成结果读，`totals` 永远取不到，
 *   页面就一直显示「内核没有返回用量数据」——看着像内核没实现。
 *   形状写在这里一处，桥包装和类型声明都引它。
 *
 *   失败时 `ok:false` 必须带 `error`：把失败说成「没有记录」等于骗用户没花过钱。
 */
export type UsageQueryEnvelope =
  { ok: true; result: UsageQueryResult } | { ok: false; error: string }

/** 「未标注」调用类别的展示名（与内核 `UNSET` 同一个字面量） */
export const USAGE_UNSET = '（未标注）'
/** 「未归属」任务/会话的展示名（与内核 `TASK_NONE` 同一个字面量） */
export const USAGE_TASK_NONE = '（未归属）'

/**
 * 账本体检结果（`core/usage-anomalies.cjs`）
 *
 * ★ `checked` 是**真跑过哪几项**的清单。界面必须按它显示「N 项已检查」，
 *   不能把没跑过的检查显示成 0 个异常 —— 那等于暗示已验证过。
 */
export interface UsageAnomalies {
  checked: string[]
  duplicates: number
  badValues: number
  missingOutcome: number
  cacheOverflow: number
  /** 参与检查的行数 */
  total: number
  /** 前几条样本（最多 5 条，用来给出可核实的证据） */
  samples: Array<{ kind: string; detail: string }>
}
