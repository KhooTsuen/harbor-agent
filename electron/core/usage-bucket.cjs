/**
 * 服务商原始 usage → `UsageBucket`（**全项目唯一一处转换**）
 *
 * ── 为什么必须有这个文件（2026-11-09 查出的真实 bug）───────────
 *
 * `llm.cjs:211` 取的是 `chunk.usage` —— 服务商原始字段：
 *
 *     { prompt_tokens, completion_tokens, total_tokens,
 *       prompt_cache_hit_tokens, prompt_cache_miss_tokens }
 *
 * 但渲染层按 `UsageBucket` 读：
 *
 *     ContextRow.tsx:58    message.usage?.cached      ← 实际叫 prompt_cache_hit_tokens
 *     StatusBar.tsx:28-29  message.usage.prompt       ← 实际叫 prompt_tokens
 *                          message.usage.completion   ← 实际叫 completion_tokens
 *
 * 中间只隔了一次 `as Message['usage']` 强转（streamEvents.ts:224），
 * TypeScript 于是没报错。**后果：状态栏的 token 数、ContextGauge 的缓存命中提示永远是 0**。
 * 这不是显示问题 —— 是「用户看到 0」被当成「确认没消耗」。
 *
 * ── 为什么在这里转而不是在渲染层转 ──────────────────────────────
 *
 * `done` 事件只有一处出口（`handlers/chat.cjs:220`），落盘（replyPersistence）
 * 和读回（disk.ts）都直接透传同一份对象。**在一处转，三条路自动都对**；
 * 在渲染层转则要改三处，而且下次谁再加一条读 usage 的路就又漏。
 *
 * ── 字段语义（复用 `token-metrics.cacheFields`，不另写一套）──────
 *
 *   · 缓存：DeepSeek 用 `prompt_cache_hit/miss_tokens`，OpenAI 用
 *     `prompt_tokens_details.cached_tokens`。差异全在 `cacheFields` 里处理。
 *   · `cached` **含在 `prompt` 里**（DeepSeek 的 hit+miss=prompt）→ 累加时绝不再加一遍。
 *   · 思考 token 属于 `completion`，同理不并列。
 *   · **没给的字段一律 `null`，不是 0**。0 是「服务商明确说这次是 0」。
 *
 * ── 保留原始对象 ────────────────────────────────────────────────
 *
 * `raw` 原样带回去：以后要查「这家到底返了什么字段」不用翻日志。
 * 它不是 `UsageBucket` 的一部分，渲染层不许读它（`bucketOf` 之外没有消费者）。
 */

const metrics = require('./token-metrics.cjs')
const budget = require('./budget.cjs')

/** 有没有任何一个 token 数 —— 决定 `known` */
function hasAnyToken(usage) {
  if (!usage || typeof usage !== 'object') return false
  return ['prompt_tokens', 'completion_tokens', 'total_tokens'].some((key) =>
    Number.isFinite(Number(usage[key])),
  )
}

/** 只在真的有限时才取数，否则 null（**不填空 0**） */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && value !== null && value !== undefined && value !== '' ? n : null
}

/**
 * @param {object|null} usage 服务商返回的原始 usage
 * @returns {null|{prompt:number|null, completion:number|null, total:number|null,
 *                 cached:number|null, cacheMiss:number|null, reasoning:number|null,
 *                 known:boolean, source:string, raw:object}}
 *   `null` = 这次调用根本没有 usage 对象（不是「全是 0」）。
 */
function bucketOf(usage) {
  if (!usage || typeof usage !== 'object') return null

  const known = hasAnyToken(usage)
  const cache = metrics.cacheFields(usage)
  const prompt = known ? num(usage.prompt_tokens) : null
  const completion = known ? num(usage.completion_tokens) : null
  const total = known ? num(usage.total_tokens) : null

  return {
    prompt,
    completion,
    /* 服务商没给 total 就按 prompt+completion 算 —— 但只在两个都有数时，否则 null */
    total: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
    /* 缓存命中：`cached` 含在 prompt 内，用法见文件头 */
    cached: cache.hit,
    cacheMiss: cache.miss,
    reasoning: known ? budget.reasoningOf(usage) : null,
    /* 有对象但一个 token 字段都没有 → 等同于「没拿到」，不许当成 0 消耗 */
    known,
    source: cache.source,
    raw: usage,
  }
}

/**
 * 把渲染层历史上就在用的 `UsageBucket` 口径补齐（它少了 `known` / `cacheMiss`）。
 *
 * 只给**已经在读旧字段**的调用方用（`StatusBar` 读 prompt/completion，
 * `ContextRow` 读 cached）。`prompt ?? 0` 在这里是合理的：它要的是「已知总量」，
 * 未知的那些**根本不计入合计**（`known:false` 时三个数都是 null，加 0 等于跳过）。
 */
function totalsOf(bucket) {
  if (!bucket) return { prompt: 0, completion: 0, total: 0, cached: 0, known: false }
  return {
    prompt: bucket.prompt ?? 0,
    completion: bucket.completion ?? 0,
    total: bucket.total ?? 0,
    cached: bucket.cached ?? 0,
    known: bucket.known === true,
  }
}

module.exports = { bucketOf, totalsOf, hasAnyToken }
