/**
 * 统一用量查询 —— **真实账本的唯一读法**（后续「用量」页 / 热力图 / ContextGauge 都走这里）
 *
 * ── 它和 `token-metrics.summarize` 的关系 ──────────────────────
 *
 * `summarize` 是上一版：**同步**读整个文件、只给总量 / 供应商 / 入口三个维度。
 * 这个文件是它的接替者，多了模型（含「同供应商同模型」的区分）、任务、会话、
 * 调用类别、按天、以及三个筛选组合；读盘走 `usage-ledger`（异步 + 增量）。
 * 两者口径逐字一致（`known` / `legacy` 的判据不重写），所以**数字对得上**。
 *
 * ── 口径（不许在各处另立一套）─────────────────────────────────
 *
 *   · `known=true`  **且**该字段有数 → 计入该项合计。缺的字段**不进合计**，
 *     只进 `fieldUnavailable` 计数。**缺 ≠ 0**。
 *   · `known=false`（失败 / 中止 / 这家中转不给 usage）→ 只进 `unknown` 计数，
 *     任何 token 合计都不加。所以「已知总量」永远不是「完整总消耗」。
 *   · 老记录（没有 `known` 字段）→ 计 `legacy`，数值照常计入（历史不能丢），
 *     但**单独标出来**，不冒充新口径采到的。
 *   · 缓存 token **包含在 prompt 里**（DeepSeek 的 hit+miss = prompt，
 *     OpenAI 的 `cached_tokens` 是 prompt 的子集）→ `promptIncludesCache: true`，
 *     **绝不再加一遍**。思考 token 同理属于 completion。
 *   · `cost` 只累服务商真返回的金额；一条都没给 → `cost` 是 `null`（不是 0 元）。
 *
 * 分天按**本机本地时区**归日（和界面上看到的「今天」一致），跨月跨年交给 `Date`。
 */

const ledger = require('./usage-ledger.cjs')

/** 语义声明：消费方读这些标志就知道「这个数怎么来的」，不用猜 */
const SEMANTICS = {
  promptIncludesCache: true,
  completionIncludesReasoning: true,
  timezone: 'local',
  costIsProviderReported: true,
  /** 老记录的判定：没有 `known` 布尔字段 */
  legacyHasNoKnownFlag: true,
}

const UNSET = '（未标注）'
const TASK_NONE = '（未归属）'

/** 数值项：只有 known 且真有数才算 */
const NUMS = ['prompt', 'completion', 'total', 'cacheHit', 'cacheMiss', 'reasoning', 'cost']

function emptyBucket() {
  const fieldUnavailable = {}
  for (const key of NUMS) fieldUnavailable[key] = 0
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
    cost: 0,
    errors: 0,
    aborted: 0,
    fieldUnavailable,
  }
}

/** 这一行有没有真实用量（判据与 `token-metrics.summarize` 逐字一致） */
function isKnown(row) {
  if (typeof row.known === 'boolean') return row.known
  /* 老记录：有 token 数字就算拿到了（那时没有 known 字段） */
  return Number(row.prompt) > 0 || Number(row.completion) > 0 || Number(row.total) > 0
}

/** 这一行的派生事实（**每行只算一次**，再分发给各维度 —— 40000 行 × 8 维度不能各算一遍） */
function rowFacts(row) {
  const known = isKnown(row)
  const facts = { known, hasFlag: typeof row.known === 'boolean', numbers: {} }
  for (const key of NUMS) {
    const value = row[key]
    facts.numbers[key] = known && Number.isFinite(value) ? value : null
  }
  return facts
}

/** 把一行累进一个桶（facts 由 rowFacts 预先算好） */
function addInto(bucket, row, f) {
  bucket.requests += 1
  if (f.known) bucket.known += 1
  else bucket.unknown += 1
  if (!f.hasFlag) bucket.legacy += 1
  if (row.outcome === 'aborted') bucket.aborted += 1
  else if (row.ok === false) bucket.errors += 1

  const unavailable = bucket.fieldUnavailable
  const n = f.numbers
  for (let i = 0; i < NUMS.length; i += 1) {
    const key = NUMS[i]
    const value = n[key]
    if (value === null) unavailable[key] += 1
    else bucket[key] += value
  }
}

/** 收尾：覆盖率 + 「没有任何一行给金额」时把 cost 归 null（不是 0 元） */
function finish(bucket) {
  bucket.coverage = bucket.requests > 0 ? Number((bucket.known / bucket.requests).toFixed(4)) : null
  /* 一条都没有真金额就给 null（含「一次都没调」的空白桶）—— 0 会被读成「确认花了 0 元」 */
  if (bucket.fieldUnavailable.cost === bucket.requests) bucket.cost = null
  return bucket
}

/** 本地时区的日期键 `YYYY-MM-DD`（和用户看到的「今天」一致） */
function dayKey(at) {
  const d = new Date(Number(at))
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function bump(map, key, row, facts) {
  const k = key || UNSET
  const bucket = map[k] ?? (map[k] = emptyBucket())
  addInto(bucket, row, facts)
  return bucket
}

/** 按天补齐空白天（热力图要能区分「没调用」和「有调用但未知」） */
function fillDays(days, from, to) {
  if (!from || !to) return days
  const have = new Map(days.map((d) => [d.day, d]))
  const out = []
  const cursor = new Date(Number(from))
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(Number(to))
  end.setHours(0, 0, 0, 0)
  /* 上限 5 年：防止传个离谱范围把内存撑爆 */
  for (let i = 0; i < 1830 && cursor <= end; i += 1) {
    const key = dayKey(cursor.getTime())
    const found = have.get(key)
    if (found) {
      out.push(found)
    } else {
      /* ★ 「这天一次都没调」：requests=0，且不含任何 token 数字 */
      out.push({ day: key, ...emptyBucket(), empty: true, coverage: null })
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/**
 * 查询真实用量。
 *
 * @param {{ from?: number, to?: number, providerId?: string, model?: string,
 *           taskId?: string, sessionId?: string, entry?: 'api'|'cli',
 *           purpose?: string, includeEmptyDays?: boolean, withRows?: boolean }} [options]
 *   `from` / `to` 是毫秒时间戳（`to` 含当毫秒）；其余为等值筛选，空 = 不筛。
 * @returns {Promise<object>} 见 `query` 里的 return（维度齐全，且每个维度内部口径相同）
 */
async function query(options = {}) {
  const from = Number(options.from) || 0
  const to = Number(options.to) || 0
  const want = (value) => String(value ?? '')
  const filters = {
    from,
    to,
    fProvider: want(options.providerId),
    fModel: want(options.model),
    fTask: want(options.taskId),
    fSession: want(options.sessionId),
    fEntry: want(options.entry),
    fPurpose: want(options.purpose),
  }
  const plain =
    !from && !to && !filters.fProvider && !filters.fModel && !filters.fTask &&
    !filters.fSession && !filters.fEntry && !filters.fPurpose && !options.withRows

  /* ★ 先读账本再比版本号：反过来的话文件刚变过时会命中过期 memo（返回"看着正常但是错的"数字） */
  const all = await ledger.loadRows()

  const onlyTime = !filters.fProvider && !filters.fModel && !filters.fTask &&
    !filters.fSession && !filters.fEntry && !filters.fPurpose && (from || to)

  /* 只按时间筛（热力图）：复用全量聚合，只重算 days —— 返回完整结构，调用方不用特判 */
  if (onlyTime && !options.withRows) {
    const stamp = ledger.currentVersion()
    if (memo.version !== stamp || !memo.result) {
      memo.version = stamp
      memo.result = aggregate(all, options, { from: 0, to: 0 })
    }
    const base = memo.result
    const days = clipDays(base.days, options, from, to)
    return {
      ...structuredClone(base),
      days,
      matched: days.reduce((sum, d) => sum + d.requests, 0),
    }
  }

  if (plain) {
    const stamp = ledger.currentVersion()
    if (memo.version === stamp && memo.result) return structuredClone(memo.result)
    const result = aggregate(all, options, filters)
    memo.version = stamp
    memo.result = result
    /* ★ 缓存的那份不能把可变引用还出去：调用方改一下 byProvider 就会污染下次查询 */
    return structuredClone(result)
  }
  return aggregate(all, options, filters)
}

/** 无筛选查询的结果缓存（`version` 对不上就重算） */
const memo = { version: -1, result: null }

/**
 * 从全量按天数组里裁出 [from, to] 这一段。
 * 空白日的语义与全量查询一致：`requests=0` + `empty:true`，**不是** 0 token。
 */
function clipDays(days, options, from, to) {
  const kept = days.filter((item) => {
    const dayStart = new Date(`${item.day}T00:00:00`).getTime()
    const dayEnd = dayStart + 86399999
    if (from && dayEnd < from) return false
    if (to && dayStart > to) return false
    return true
  })
  return options.includeEmptyDays ? fillDays(kept, from, to) : kept
}

/** 纯内存聚合（不读盘）—— `all` 是已读好的账本行 */
function aggregate(all, options, filters) {
  const { from = 0, to = 0, fProvider = '', fModel = '', fTask = '', fSession = '', fEntry = '', fPurpose = '' } = filters
  const rows = all.filter((row) => {
    if (from && Number(row.at) < from) return false
    if (to && Number(row.at) > to) return false
    if (fProvider && String(row.providerId ?? '') !== fProvider) return false
    if (fModel && String(row.model ?? '') !== fModel) return false
    if (fTask && String(row.taskId ?? '') !== fTask) return false
    if (fSession && String(row.sessionId ?? '') !== fSession) return false
    if (fEntry && String(row.entry ?? 'api') !== fEntry) return false
    /* 空串 = 未标注：筛选时按「未标注」这个展示名匹配（不然界面上点它永远查不到） */
    if (fPurpose && String(row.purpose || UNSET) !== fPurpose) return false
    return true
  })

  const out = {
    semantics: SEMANTICS,
    /** 账本里一共有多少行（不受筛选影响）—— 用于「N 天里有 M 条」这类说明 */
    scanned: all.length,
    matched: rows.length,
    totals: emptyBucket(),
    byProvider: {},
    byModel: {},
    /** 供应商 + 模型：**同名模型分属两家时靠它区分**（单看 byModel 会合并） */
    byProviderModel: {},
    byPurpose: {},
    byEntry: {},
    byTask: {},
    bySession: {},
    byDay: {},
  }

  for (const row of rows) {
    const facts = rowFacts(row)
    addInto(out.totals, row, facts)
    bump(out.byProvider, row.providerId, row, facts)
    bump(out.byModel, row.model, row, facts)
    bump(out.byProviderModel, `${row.providerId || UNSET}\u0000${row.model || UNSET}`, row, facts)
    bump(out.byPurpose, row.purpose || UNSET, row, facts)
    bump(out.byEntry, row.entry || 'api', row, facts)
    /* 任务 / 会话只对「真有归属」的记：空串进单独的桶，不冒充某个具体任务 */
    bump(out.byTask, row.taskId || TASK_NONE, row, facts)
    bump(out.bySession, row.sessionId || TASK_NONE, row, facts)
    const day = dayKey(row.at)
    if (day) bump(out.byDay, day, row, facts)
  }

  finish(out.totals)
  for (const map of [out.byProvider, out.byModel, out.byProviderModel, out.byPurpose, out.byEntry, out.byTask, out.bySession]) {
    for (const key of Object.keys(map)) finish(map[key])
  }
  for (const key of Object.keys(out.byProviderModel)) {
    const [providerId, model] = key.split('\u0000')
    out.byProviderModel[key].providerId = providerId
    out.byProviderModel[key].model = model
  }

  /* 按天升序的数组（热力图直接吃）；默认只给有记录的天 */
  let days = Object.keys(out.byDay)
    .sort()
    .map((day) => ({ day, ...finish(out.byDay[day]) }))
  if (options.includeEmptyDays) days = fillDays(days, from, to)
  out.days = days

  /* 原始行（诊断用；默认不给 —— 调用方要了才附上，避免 IPC 传大数据） */
  if (options.withRows) out.rows = rows
  return out
}

module.exports = { query, dayKey, isKnown, emptyBucket, SEMANTICS, UNSET, TASK_NONE }
