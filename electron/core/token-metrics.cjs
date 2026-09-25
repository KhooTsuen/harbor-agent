/**
 * 每请求 token 指标（token 优化 · 指标）
 *
 * 落盘：data/logs/token-metrics.jsonl —— 一行一个请求，**只记数字与 hash，不记内容**。
 *
 * 缓存字段纪律（写死在代码里，别改口径）：
 *   · 以 API 实际返回为准：DeepSeek 用 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
 *     OpenAI 用 prompt_tokens_details.cached_tokens；
 *   · **供应商没给就记 null（unavailable），绝不填 0 冒充**；
 *   · 命中率只在 hit 与 miss 都在时才算（hit/(hit+miss)）；只有 hit 没有 miss 时不造分母。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

const file = () => path.join(DIRS.logs, 'token-metrics.jsonl')

/** 从原始 usage 里取缓存字段（返回 null = 供应商没给） */
function cacheFields(usage) {
  if (!usage || typeof usage !== 'object') return { hit: null, miss: null, source: 'none' }
  const hit = Number(usage.prompt_cache_hit_tokens)
  const miss = Number(usage.prompt_cache_miss_tokens)
  if (Number.isFinite(hit) || Number.isFinite(miss)) {
    return {
      hit: Number.isFinite(hit) ? hit : null,
      miss: Number.isFinite(miss) ? miss : null,
      source: 'deepseek-style',
    }
  }
  const cached = Number(usage.prompt_tokens_details?.cached_tokens)
  if (Number.isFinite(cached)) return { hit: cached, miss: null, source: 'openai-style' }
  return { hit: null, miss: null, source: 'unavailable' }
}

/** hit/(hit+miss)；缺任一分量 → null（不可计算，不估） */
function hitRate(hit, miss) {
  if (!Number.isFinite(hit) || !Number.isFinite(miss)) return null
  const total = hit + miss
  return total > 0 ? Number((hit / total).toFixed(4)) : null
}

function recordRequest(row) {
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true })
    fs.appendFileSync(file(), `${JSON.stringify({ at: Date.now(), ...row })}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 一次成功的模型调用 → 一行指标（llm.cjs 直接调它，保持那边行数可控）。
 *
 * @param {{ label?: string, model?: string, providerId?: string, trace?: string,
 *           retryIndex?: number, usage?: object, ttftMs?: number|null, latencyMs?: number }} input
 */
function logLlm(input = {}) {
  const usage = input.usage ?? null
  const cache = cacheFields(usage)
  return recordRequest({
    kind: 'llm',
    ok: true,
    label: String(input.label ?? '').slice(0, 40),
    model: String(input.model ?? ''),
    providerId: String(input.providerId ?? ''),
    trace: String(input.trace ?? ''),
    retryIndex: Number(input.retryIndex) || 0,
    prompt: Number(usage?.prompt_tokens) || 0,
    completion: Number(usage?.completion_tokens) || 0,
    total: Number(usage?.total_tokens) || 0,
    cacheHit: cache.hit,
    cacheMiss: cache.miss,
    cacheSource: cache.source,
    hitRate: hitRate(cache.hit, cache.miss),
    ttftMs: Number.isFinite(input.ttftMs) ? input.ttftMs : null,
    latencyMs: Number.isFinite(input.latencyMs) ? input.latencyMs : null,
  })
}

/**
 * 汇总（给报告用）。
 *
 * @param {{ sinceMs?: number, kind?: string }} options
 */
function summarize({ sinceMs = 0, kind = '' } = {}) {
  let rows = []
  try {
    rows = fs
      .readFileSync(file(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    rows = []
  }
  if (sinceMs) rows = rows.filter((r) => r.at >= sinceMs)
  if (kind) rows = rows.filter((r) => r.kind === kind)

  const out = {
    requests: rows.length,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheUnavailable: 0,
    rateable: 0,
    retries: 0,
    errors: 0,
  }
  for (const r of rows) {
    out.prompt += Number(r.prompt) || 0
    out.completion += Number(r.completion) || 0
    out.total += Number(r.total) || 0
    if (Number.isFinite(r.cacheHit)) out.cacheHit += r.cacheHit
    else out.cacheUnavailable += 1
    if (Number.isFinite(r.cacheMiss)) out.cacheMiss += r.cacheMiss
    if (Number.isFinite(r.cacheHit) && Number.isFinite(r.cacheMiss)) out.rateable += 1
    out.retries += Number(r.retryIndex) || 0
    if (r.ok === false) out.errors += 1
  }
  out.hitRate =
    out.rateable > 0 ? Number((out.cacheHit / (out.cacheHit + out.cacheMiss)).toFixed(4)) : null
  return out
}

module.exports = { file, cacheFields, hitRate, recordRequest, logLlm, summarize }
