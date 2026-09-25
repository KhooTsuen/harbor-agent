/**
 * 用量统计
 *
 * 记服务端返回的 token 用量，分三类累计：总量 / 按天 / 按模型。
 * 为什么要按天：用户想知道「这个月花了多少」，只有总量答不出来。
 *
 * 为什么不用数据库：一天几十条，一个 JSON 文件够用，而且能直接打开看。
 *
 * 注意：token 数由服务端返回，不是自己估的。服务端不给 usage 的
 * 供应商（少数第三方中转）就记不上，这一项本来就是尽力而为。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/** 按天数据只留这么久，不然文件会一直长 */
const KEEP_DAYS = 90

function statsFile() {
  return path.join(DIRS.data, 'stats.json')
}

function emptyBucket() {
  /* cached：命中 prompt 缓存的 token 数（命中部分便宜很多）
     cacheMiss：服务端**显式给的**未命中数（DeepSeek 的 prompt_cache_miss_tokens）——
                没给就保持 0，但报告侧一律按「不可计算」处理（见 token-metrics.cjs） */
  return { prompt: 0, completion: 0, total: 0, calls: 0, cached: 0, cacheMiss: 0 }
}

function emptyData() {
  return { version: 1, since: Date.now(), total: emptyBucket(), byDay: {}, byModel: {} }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(statsFile(), 'utf8'))
    /* 手改坏了也要能用：缺什么补什么 */
    return {
      version: 1,
      since: Number(raw?.since) || Date.now(),
      total: { ...emptyBucket(), ...(raw?.total ?? {}) },
      byDay: raw?.byDay && typeof raw.byDay === 'object' ? raw.byDay : {},
      byModel: raw?.byModel && typeof raw.byModel === 'object' ? raw.byModel : {},
    }
  } catch {
    return emptyData()
  }
}

function save(data) {
  try {
    fs.mkdirSync(DIRS.data, { recursive: true })
    fs.writeFileSync(statsFile(), JSON.stringify(data, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 按**本地日期**分桶（YYYY-MM-DD）。
 *
 * ⚠️ 原来用的是 `toISOString()` —— 那是 **UTC**。对 UTC+8 的用户来说，
 * 「今天」会在早上 8 点才切换，日用量和日限额的边界都是错的。
 * 用户心里的「今天」是本地的那一天。
 *
 * 这个函数**必须只有一份**：用量闸要按同一口径算账，
 * 两处各写一个日期函数就会悄悄错开（踩过：闸门永远算成 0，等于没有）。
 * 所以 limits.cjs 直接 require 这个，不自己实现。
 */
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function addInto(bucket, usage) {
  bucket.prompt += Number(usage.prompt_tokens) || 0
  bucket.completion += Number(usage.completion_tokens) || 0
  bucket.total +=
    Number(usage.total_tokens) ||
    (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0)
  /*
   * 缓存命中的 token。两家字段不一样：
   *   DeepSeek: prompt_cache_hit_tokens
   *   OpenAI:   prompt_tokens_details.cached_tokens
   * 以前这两处都没读 —— 命中率到底多少，一直是笔糊涂账。
   */
  bucket.cached +=
    Number(usage.prompt_cache_hit_tokens) || Number(usage.prompt_tokens_details?.cached_tokens) || 0
  bucket.cacheMiss += Number(usage.prompt_cache_miss_tokens) || 0
  bucket.calls += 1
}

/** 砍掉过期的按天数据，返回是否改动过 */
function prune(data) {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  let changed = false
  for (const day of Object.keys(data.byDay)) {
    if (day < cutoff) {
      delete data.byDay[day]
      changed = true
    }
  }
  return changed
}

/**
 * 记一次调用。
 *
 * @param {object} usage  服务端返回的 { prompt_tokens, completion_tokens, total_tokens }
 * @param {string} model  模型名，用于按模型分组
 */
function record(usage, model) {
  if (!usage || typeof usage !== 'object') return { ok: false, error: '没有 usage' }
  const hasAny =
    Number(usage.prompt_tokens) || Number(usage.completion_tokens) || Number(usage.total_tokens)
  if (!hasAny) return { ok: false, error: 'usage 里没有 token 数' }

  const data = load()
  addInto(data.total, usage)

  const day = today()
  data.byDay[day] = data.byDay[day] ?? emptyBucket()
  addInto(data.byDay[day], usage)

  const name = String(model || '未知模型')
  data.byModel[name] = data.byModel[name] ?? emptyBucket()
  addInto(data.byModel[name], usage)

  prune(data)
  return save(data)
}

/** 给界面看：总量 + 最近 30 天 + 按模型降序 */
function summary() {
  const data = load()

  const days = Object.entries(data.byDay)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 30)
    .map(([day, bucket]) => ({ day, ...bucket }))

  const models = Object.entries(data.byModel)
    .map(([model, bucket]) => ({ model, ...bucket }))
    .sort((a, b) => b.total - a.total)

  return {
    since: data.since,
    total: data.total,
    days,
    models,
    file: statsFile(),
  }
}

function reset() {
  const result = save(emptyData())
  log.info('用量统计已清空')
  return result
}

module.exports = { record, summary, reset, load, statsFile, today, KEEP_DAYS }
