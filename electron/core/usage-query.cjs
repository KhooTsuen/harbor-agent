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
const anomalies = require('./usage-anomalies.cjs')

/** 语义声明：消费方读这些标志就知道「这个数怎么来的」，不用猜 */
const SEMANTICS = {
  promptIncludesCache: true,
  completionIncludesReasoning: true,
  timezone: 'local',
  costIsProviderReported: true,
  /** 老记录的判定：没有 `known` 布尔字段 */
  legacyHasNoKnownFlag: true,
}

/* 桶 / 事实 / 累加 / 收尾在 usage-bucket-core.cjs（那边有命中率的实测数字） */
const core = require('./usage-bucket-core.cjs')
const { UNSET, TASK_NONE, emptyBucket, isKnown, rowFacts, addInto, finish } = core

/** 本地时区的日期键 `YYYY-MM-DD`（和用户看到的「今天」一致；实现在 usage-day.cjs） */
const usageDay = require('./usage-day.cjs')
const { dayIndexOf, labelOf, dayKey } = usageDay

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

  /*
   * 只按时间筛（页首 + 热力图）：**在时间窗内做完整聚合**。
   * 2026-11-09 修的两件事：① 以前是「全量聚合再裁 days」——概览/排行的数字是
   * 全部历史，标题却写「最近 30 天」，同一页面两套口径；② 全量聚合 4 万行要
   * ~210ms 且期间事件循环一次都不转。限定窗口后只剩几千行（约 10ms）。
   * 缓存键必须带 (from,to)：窗口不同结果就不同。
   */
  if (onlyTime && !options.withRows) {
    const key = `${ledger.currentVersion()}|${from}|${to}|${options.includeEmptyDays ? 1 : 0}`
    if (timeMemo.key !== key) {
      timeMemo.key = key
      timeMemo.result = await aggregateAsync(all, options, { ...filters })
    }
    return structuredClone(timeMemo.result)
  }

  if (plain) {
    const stamp = ledger.currentVersion()
    if (memo.version === stamp && memo.result) return structuredClone(memo.result)
    const result = await aggregateAsync(all, options, filters)
    memo.version = stamp
    memo.result = result
    /* ★ 缓存的那份不能把可变引用还出去：调用方改一下 byProvider 就会污染下次查询 */
    return structuredClone(result)
  }
  return aggregateAsync(all, options, filters)
}

/** 无筛选查询的结果缓存（`version` 对不上就重算） */
const memo = { version: -1, result: null }

/** 按时间窗查询的缓存：键 = 版本|from|to|补齐空白日（窗口不同，结果就不同） */
const timeMemo = { key: '', result: null }

/** 纯内存聚合（不读盘）—— `all` 是已读好的账本行 */
/**
 * 纯内存聚合（不读盘）—— `all` 是已读好的账本行
 *
 * ★ 分片让出事件循环（2026-11-09）：10 万行全量聚合要 ~300ms，期间定时器一次
 *   都不触发（实测采样 0 次）—— 那就是「界面冻住」。现在每 5000 行 `await` 一次
 *   宏任务，把控制权还给事件循环，渲染层和别的 IPC 都能插进来。
 *
 *   代价：总耗时略增（多了几次调度），换来「最长停顿从 300ms 降到个位数」。
 *   这个取舍在设置页是可接受的：用户看到的是「统计慢慢填满」而不是「窗口卡死」。
 */
const SLICE = 5000

/** 让出一轮宏任务（`setImmediate` 比 `setTimeout(0)` 快，且不排进定时器队列） */
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function aggregateAsync(all, options, filters) {
  const { from = 0, to = 0, fProvider = '', fModel = '', fTask = '', fSession = '', fEntry = '', fPurpose = '' } = filters
  /* 筛选也分片：10 万行 × 8 个条件同样可能上百毫秒 */
  const rows = []
  for (let i = 0; i < all.length; i += 1) {
    const row = all[i]
    if (i > 0 && i % SLICE === 0) await yieldToLoop()
    const at = Number(row.at)
    if (from && at < from) continue
    if (to && at > to) continue
    if (fProvider && String(row.providerId ?? '') !== fProvider) continue
    if (fModel && String(row.model ?? '') !== fModel) continue
    if (fTask && String(row.taskId ?? '') !== fTask) continue
    if (fSession && String(row.sessionId ?? '') !== fSession) continue
    if (fEntry && String(row.entry ?? 'api') !== fEntry) continue
    /* 空串 = 未标注：筛选时按「未标注」这个展示名匹配（不然界面上点它永远查不到） */
    if (fPurpose && String(row.purpose || UNSET) !== fPurpose) continue
    rows.push(row)
  }
  return buildResult(rows, all.length, options, filters)
}

/** 同步版（少量数据 / 测试用；行为与 async 版逐字一致） */
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
    if (fPurpose && String(row.purpose || UNSET) !== fPurpose) return false
    return true
  })
  return buildResult(rows, all.length, options, filters)
}

/** 已筛好的行 → 完整结果（同步；两个 aggregate 共用，口径只有这一份） */
function buildResult(rows, scanned, options, filters) {

  const out = {
    semantics: SEMANTICS,
    /** 账本里一共有多少行（不受筛选影响）—— 用于「N 天里有 M 条」这类说明 */
    scanned,
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

  /*
   * ★ 按天这一维用**日序号（数字）当键**，最后再转 `YYYY-MM-DD`。
   *   以前每行都调 `dayKey(row.at)`（内部 new Date + 取三个分量），4 万行 12ms，
   *   是全量聚合里最大的单项。现在同一天只算一次（见 usage-day.cjs）。
   */
  const byDayIndex = new Map()
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
    const dayIndex = dayIndexOf(row.at)
    if (Number.isFinite(dayIndex)) {
      const bucket = byDayIndex.get(dayIndex) ?? emptyBucket()
      addInto(bucket, row, facts)
      byDayIndex.set(dayIndex, bucket)
    }
  }
  /* 数字键 → 日期字符串（外部形状不变：`byDay` 的键始终是 `YYYY-MM-DD`） */
  for (const [index, bucket] of byDayIndex) {
    const label = labelOf(index)
    if (!label) continue
    out.byDay[label] = bucket
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
  if (options.includeEmptyDays) days = fillDays(days, Number(filters.from) || 0, Number(filters.to) || 0)
  out.days = days

  if (options.withRows) {
    /*
     * ★ 明细行也要带**同一份** `known` 判据（2026-11-09 真机逮到）。
     *
     * 病：老账本行里根本没有 `known` 字段（那时还没这个口径）。聚合侧走
     * `isKnown()` 兜底，所以汇总数是对的；但明细把原始行直接给渲染层，那边判
     * `row.known === false` —— `undefined === false` 是假，于是「没上报」被
     * 渲染成 **3 个 0**（输入/输出/合计）。用户看到 0 会当成「确认没消耗」，
     * 正是本阶段要根除的那件事。
     *
     * 修在一处：判据只有 `isKnown` 这一份定义，渲染层照旧只读 `known`。
     * 有 `known` 的行原样给（不覆盖账本里已有的判断）。
     */
    out.rows = rows.map((row) => ('known' in row ? row : { ...row, known: isKnown(row) }))
  } /* 诊断用，默认不给：走 IPC 传大数组很贵 */
  out.anomalies = anomalies.checkRows(rows) /* 只报能确证的四类，见 usage-anomalies.cjs */
  return out
}

module.exports = { query, dayKey: usageDay.dayKey, isKnown, emptyBucket, SEMANTICS, UNSET, TASK_NONE }
