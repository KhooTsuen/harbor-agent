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
const retention = require('./data-retention.cjs')
/* 思考 token 的取法只有一处（budget.reasoningOf）—— 这里不重写字段路径 */
const budget = require('./budget.cjs')

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
  const sum = hit + miss
  return sum > 0 ? Number((hit / sum).toFixed(4)) : null
}

/**
 * 一次模型调用尝试 → 一行账。
 *
 * ★ 为什么叫「尝试」而不是「请求」（2026-11-07 第 6 项）：
 *   一次用户可见的调用可能真发 3 次（重试）。**每一次真发出去的都单独记账** ——
 *   不然后两次的消耗在账上凭空消失，而前两次的失败又查不到。
 *
 * ★ 三类数值必须分得开（这是这一层存在的理由）：
 *   · `known: true` + 数字 → 确实上报了（**给 0 也算上报**，不能当成没报）
 *   以前统一 `Number(x) || 0`，第三种被写成 0 混进累计 —— 用户看到的「消耗」里
 *   掺着猜的值，而这正是本项要根除的东西。
 *
 * @param {{ entry?: 'api'|'cli', providerId?: string, model?: string,
 *           sessionId?: string, trace?: string, taskId?: string, retryIndex?: number,
 *           outcome?: 'ok'|'failed'|'aborted', usage?: object|null,
 *           reason?: string, ttftMs?: number|null, latencyMs?: number|null, label?: string,
 *           purpose?: string }} input
 *   `purpose` = 调用类别（chat / compact / scene / vision / prewarm / collab…），统计按它分类；
 *   不给就留空 → 归「未标注」，**不猜成 chat**。`usage` 传 null = 没拿到真实用量，照记这一行。
 */
function logAttempt(input = {}) {
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : null
  const cache = cacheFields(usage)
  /* 有对象但一个 token 字段都没有 → 同样算「没拿到」，不当成 0 */
  const anyToken = usage
    ? ['prompt_tokens', 'completion_tokens', 'total_tokens'].some((k) => Number.isFinite(Number(usage[k])))
    : false
  const known = Boolean(usage) && anyToken
  const num = (value) => (known && Number.isFinite(Number(value)) ? Number(value) : null)

  return recordRequest({
    kind: 'llm',
    entry: input.entry === 'cli' ? 'cli' : 'api',
    /* `ok` 保留：老报告脚本按它筛（`summarize` 里 out.errors 数它） */
    ok: input.outcome === 'ok' || input.outcome === undefined,
    outcome: input.outcome ?? 'ok',
    /* ★ 这一行到底有没有真实用量 —— 统计侧只累 known 的行 */
    known,
    missing: known ? '' : String(input.reason ?? (usage ? 'usage 里没有 token 数' : '没有 usage')).slice(0, 80),
    label: String(input.label ?? '').slice(0, 40),
    /* ★ 显式调用类别（2026-11-08）。`label` 是自由文本，压缩/识图/协作根本没有它，
       拿它分类等于猜。这里是**唯一**能把「主对话 / 压缩 / 场景 / 识图 / 预热 / 协作」
       分开的字段；调用方不给就留空，统计侧归「未标注」，不猜成 chat。 */
    purpose: String(input.purpose ?? '').slice(0, 16),
    model: String(input.model ?? ''),
    providerId: String(input.providerId ?? ''),
    sessionId: String(input.sessionId ?? '').slice(0, 40),
    trace: String(input.trace ?? ''),
    taskId: String(input.taskId ?? '').slice(0, 40),
    retryIndex: Number(input.retryIndex) || 0,
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
    total: num(usage?.total_tokens),
    /* 思考 token 没给就 null，不填 0 —— 与上面同一条纪律 */
    reasoning: known ? (budget.reasoningOf(usage) ?? null) : null,
    cacheHit: cache.hit,
    cacheMiss: cache.miss,
    cacheSource: cache.source,
    hitRate: hitRate(cache.hit, cache.miss),
    /* 费用：**只有服务商真给了金额才记**。本地定价表算出来的一律不写在这里
       （那块留在 pricing 侧做「预估」，两者永远不混）。目前没有一家返回金额。 */
    cost: Number.isFinite(Number(usage?.cost)) ? Number(usage.cost) : null,
    costSource: Number.isFinite(Number(usage?.cost)) ? 'provider' : 'unavailable',
    ttftMs: Number.isFinite(input.ttftMs) ? input.ttftMs : null,
    latencyMs: Number.isFinite(input.latencyMs) ? input.latencyMs : null,
  })
}

function recordRequest(row) {
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true })
    const line = `${JSON.stringify({ at: Date.now(), ...row })}\n`
    /* 审计问题 4：这个文件以前**只增不减** —— 超 6MB 就留一份 `.1` 再重开
       （和 `log-actions.cjs` 同一套做法，所以总量有界：转出来的那份下次会被盖掉） */
    retention.rotateFile(file(), line.length)
    fs.appendFileSync(file(), line, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 兜底记账：**每一次真发出去的 HTTP 请求**都会落到这里（`llm.chatStream` 的出口）。
 *
 * ── 为什么要有兜底（2026-11-08）──────────────────────────────
 *
 * 主对话的记账点搬到了 `loop-model.cjs` 的重试循环（那里才知道「第几次、发给谁」）。
 * 但**压缩 / 场景（标题·翻译·建议）/ 协作**这三条路根本不经过那个循环 ——
 * 它们直接调 `llm.chatStream`。搬完以后它们一条账都不落：账本上「今天用了多少」
 * 会比真实少，而少的那部分正是后台悄悄烧掉的。
 *
 * 所以出口这里再兜一层：调用方自己记过了（传 `accounted: true`）就跳过，
 * 没记过就补一笔 —— 判据仍然只有一处（本文件的 `buildRow`），不另立口径。
 * 新增供应商 / 新增调用方都不用再想着「记得记账」。
 *
 * @param {object} options `llm.chatStream` 的入参（取 provider / model / traceId / taskId）
 * @param {object|null} result 成功时的返回（取 usage / ttftMs / latencyMs）
 * @param {Error|null} error 失败时的异常（判中止还是失败）
 */
function autoLog(options = {}, result = null, error = null) {
  if (options.accounted) return { ok: false, skipped: 'caller-accounted' }
  const aborted = Boolean(error) && (error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? '')))
  return logAttempt({
    /* 入口类型按**后端种类**判（判据在 `provider-kinds.cjs`，别在这儿另写一份） */
    entry: require('./provider-kinds.cjs').isCodexCli(options.provider) ? 'cli' : 'api',
    outcome: error ? (aborted ? 'aborted' : 'failed') : 'ok',
    providerId: options.provider?.id ?? '',
    model: options.model ?? '',
    label: options.label ?? '',
    /* 调用方显式声明类别；不声明就留空（统计里算「未标注」，不冒充 chat） */
    purpose: options.purpose ?? '',
    sessionId: options.sessionId ?? '',
    trace: options.traceId ?? '',
    taskId: options.taskId ?? '',
    retryIndex: options.retryIndex ?? 0,
    usage: result?.usage ?? null,
    reason: error ? String(error?.message ?? error) : '',
    ttftMs: result?.ttftMs ?? null,
    latencyMs: result?.latencyMs ?? null,
  })
}

/**
 * 一次**成功的**模型调用 → 一行账（老调用方的入口，判据与 logAttempt 同一处）。
 *
 * `trace` 与 `taskId` 是**两个东西，都记、谁也不替代谁**（P2，2026-11-05）：
 *   · `trace`  = 这一轮**运行实例**的 key（生产里是 `req_*`，`chat.cjs` 的 phaseKey）
 *   · `taskId` = **任务台账** id（`task_*`，`loop-run` 建/复用的那条）
 * 调用方没给 taskId 就记空串，**不猜**：起标题 / 起建议 / 预热 / 压缩这些辅助调用
 * 本来就不属于任何任务。
 *
 * @param {{ label?: string, model?: string, providerId?: string, trace?: string,
 *           sessionId?: string, taskId?: string, retryIndex?: number, usage?: object|null,
 *           entry?: 'api'|'cli', outcome?: 'ok'|'failed'|'aborted',
 *           ttftMs?: number|null, latencyMs?: number|null }} input
 */
function logLlm(input = {}) {
  /* 兼容老调用方（prewarm 等辅助调用）：一律走 logAttempt，判据只有一处 */
  return logAttempt({ ...input, entry: input.entry ?? 'api', outcome: input.outcome ?? 'ok' })
}

/**
 * 汇总（给报告 / 后续界面用）。
 *
 * ★ 三类请求数必须分开报（2026-11-07 第 6 项）：
 *   `known`   —— 真的拿到了用量，数字可信
 *   `unknown` —— 没拿到（失败 / 中止 / 这家中转不给 usage），**不许按 0 计入**
 *   `legacy`  —— 老记录（这个字段还没有的时候写的），单独标出来，
 *                免得新旧混着算完被标成「实际消耗」
 *
 * @param {{ sinceMs?: number, kind?: string, entry?: ''|'api'|'cli' }} options `entry` 传空 = 不筛入口
 */
function summarize(options = {}) {
  const sinceMs = Number(options.sinceMs) || 0
  const kind = String(options.kind ?? '')
  const entry = String(options.entry ?? '')
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
  if (entry) rows = rows.filter((r) => (r.entry ?? 'api') === entry)

  const out = {
    requests: rows.length,
    /* 到底几行有真实用量 / 几行没有 —— 界面要能说「N 次里 M 次有数据」 */
    known: 0,
    unknown: 0,
    legacy: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    /* 思考 token（CE-019）：老记录没有这个字段 → 只累计给了数的那些，另记给了几条 */
    reasoning: 0,
    reasoningUnavailable: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheUnavailable: 0,
    rateable: 0,
    retries: 0,
    errors: 0,
    aborted: 0,
    /* 服务商真给了金额的才累计；`costUnavailable` = 有这么多行没给 */
    cost: 0,
    costUnavailable: 0,
    byProvider: {},
    byEntry: {},
  }
  const bump = (map, key, value) => {
    map[key] = map[key] ?? { requests: 0, known: 0, unknown: 0, prompt: 0, completion: 0, total: 0 }
    map[key].requests += 1
    if (value.known) map[key].known += 1
    else map[key].unknown += 1
    map[key].prompt += value.prompt
    map[key].completion += value.completion
    map[key].total += value.total
  }

  for (const r of rows) {
    /*
     * `known` 字段是本轮新加的。老记录没有它 —— 那些都是成功走完的调用，
     * 按「有 token 数字就算拿到了」判，并计入 legacy（不假装它是新口径采到的）。
     */
    const hasFlag = typeof r.known === 'boolean'
    const known = hasFlag ? r.known : Number(r.prompt) > 0 || Number(r.completion) > 0 || Number(r.total) > 0
    if (!hasFlag) out.legacy += 1
    if (known) out.known += 1
    else out.unknown += 1

    const p = known ? Number(r.prompt) || 0 : 0
    const c = known ? Number(r.completion) || 0 : 0
    const t = known ? Number(r.total) || 0 : 0
    out.prompt += p
    out.completion += c
    out.total += t
    if (Number.isFinite(r.reasoning)) out.reasoning += r.reasoning
    else out.reasoningUnavailable += 1
    if (Number.isFinite(r.cacheHit)) out.cacheHit += r.cacheHit
    else out.cacheUnavailable += 1
    if (Number.isFinite(r.cacheMiss)) out.cacheMiss += r.cacheMiss
    if (Number.isFinite(r.cacheHit) && Number.isFinite(r.cacheMiss)) out.rateable += 1
    if (Number.isFinite(r.cost)) out.cost += r.cost
    else out.costUnavailable += 1
    out.retries += Number(r.retryIndex) || 0
    if (r.outcome === 'aborted') out.aborted += 1
    else if (r.ok === false) out.errors += 1

    bump(out.byProvider, String(r.providerId || '（未标注）'), { known, prompt: p, completion: c, total: t })
    bump(out.byEntry, String(r.entry ?? 'api'), { known, prompt: p, completion: c, total: t })
  }
  out.hitRate =
    out.rateable > 0 ? Number((out.cacheHit / (out.cacheHit + out.cacheMiss)).toFixed(4)) : null
  /* 没有任何一行给金额 → 这个数是「未提供」，不是 0 元 */
  out.cost = out.costUnavailable === rows.length ? null : out.cost
  return out
}

module.exports = { file, cacheFields, hitRate, recordRequest, logAttempt, autoLog, logLlm, summarize }
