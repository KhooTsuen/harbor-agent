/**
 * 类型声明：让 `src/**` 下的 vitest 测试拿到 `usage-bucket.cjs` 的类型
 * （内核模块不参与主 tsconfig —— 它只 include `src`）。
 *
 * 实现见 `usage-bucket.cjs`。
 */

/** 服务商原始 usage（各家字段不同，缺的就没有这个键） */
export interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** DeepSeek 方言 */
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  /** OpenAI 方言 */
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  [key: string]: unknown
}

/**
 * 归一后的单次请求用量。
 *
 * ★ `null` = **没上报**（不是 0）；`known: false` 时其余字段全是 `null`。
 *   明确返回 0 时字段是 `0` 且 `known: true`。
 */
export interface BucketResult {
  prompt: number | null
  completion: number | null
  total: number | null
  /** 缓存命中（**含在 prompt 内**，别再加一遍） */
  cached: number | null
  /** 缓存未命中（只有 DeepSeek 给） */
  cacheMiss: number | null
  /** 思考 token（**含在 completion 内**） */
  reasoning: number | null
  known: boolean
  /** `deepseek-style` / `openai-style` / `unavailable` */
  source: string
  /** 原始对象原样带回（诊断用，界面不许读） */
  raw?: RawUsage
}

/** 原始 usage → 归一口径。`usage` 为空/无效时返回 `known: false` 的桶 */
export function bucketOf(usage: RawUsage | null | undefined): BucketResult

/** 这份**原始** usage 里有没有任何真实数字（用于「这张卡该不该显示」） */
export function hasAnyToken(usage: RawUsage | null | undefined): boolean

/** 把一个桶里的**已知**值取成数字合计（`null` 按「不计入」处理，不按 0 冒充） */
export function totalsOf(bucket: BucketResult | null | undefined): {
  prompt: number
  completion: number
  total: number
  cached: number
  known: boolean
}
