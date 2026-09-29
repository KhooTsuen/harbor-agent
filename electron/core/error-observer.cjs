/**
 * 内核：错误观察哨
 *
 * 干什么：把「出过的错」原样记下来 —— 谁抛的、什么分类、原始信息、在哪。
 * **只记录，不修复、不改行为、不弹窗**。看它的是 `node scripts/errors.mjs`。
 *
 * ── 三条必须守住的底线 ──
 *
 * 1. **绝不抛异常、绝不拖慢**。它挂在 catch 块里，自己再抛就把原始错误盖掉了
 *    （查错时最怕这个）。所有分支都包在 try/catch 里，失败只涨一个内部计数。
 *
 * 2. **默认关闭，要 `install()` 才开**。这条不是洁癖：内核自检（`npm test`）
 *    会**故意**制造几百个错误，如果自检期间观察哨开着，等于往用户真实数据目录里
 *    灌一堆假错误 —— 现在 `data/logs` 里 99.4% 的 ERROR 就是自检灌的，那个坑
 *    已经踩过一次，不能再开一个。自检不调 `install()`，所以自检一条都不写。
 *
 * 3. **定时器必须 `unref()`**。自检/CLI 里只要有活着的 timer，node 就永远不退出
 *    —— 表现是「自检卡住不动」，极难查。
 *
 * ── 两个和原始方案不一样的决定 ──
 *
 * · **只追加，不原地改**（一天一个 `data/errors/YYYY-MM-DD.jsonl`）。
 *   原始方案要求「同一错误一小时内只留一条」。没这么做，因为：
 *   ① 读取侧（`scripts/errors.mjs`）本来就按签名合并计数，写的时候去重是重复劳动；
 *   ② 原地改文件要读-改-写，崩在半路整份就废了，而「不覆盖」和 audit/sessions 一致。
 *   代价是同一个错在文件里可能出现多次 —— 读的时候会合成一条，不影响看。
 *
 * · **严重性不在这里定**，只存 `kind` + 分类器给的 `needsUser/retryable`。
 *   严重性是「看的人怎么理解」，归读取侧一处算（`scripts/errors/severity.mjs`）。
 *   两边各写一套，迟早对不上。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const errorsCore = require('./errors.cjs')
const { redact } = require('./redact.cjs')

/** 内存里最多留多少条（环形，超了丢最旧的并计数） */
const MAX_BUFFER = 500
/** 攒够这么多条就立刻落盘，不等定时器 —— 崩溃时少丢东西 */
const BURST = 10
/** 定时落盘间隔 */
const FLUSH_MS = 15_000
/** 同一签名在这段时间内算「重复」，只涨计数不写新行 */
const DEDUP_MS = 60_000
/** 重复计数表最多记这么多个签名 */
const MAX_SIGNATURES = 200
/** 单条字段长度上限 —— 别让一个巨型堆栈把文件撑爆 */
const MAX_TEXT = 600
const MAX_RAW = 2000

const state = {
  enabled: false,
  dir: '',
  entries: [],
  pending: [],
  seen: new Map(),
  timer: null,
  stats: { recorded: 0, written: 0, dropped: 0, failed: 0, repeats: 0 },
}

/** 任何东西 → 一行可读文本（Error 取 message，别的 String()） */
function toText(subject) {
  if (subject instanceof Error) return subject.message || subject.name || '未知错误'
  if (typeof subject === 'string') return subject
  if (subject == null) return ''
  try {
    return typeof subject === 'object' ? JSON.stringify(subject) : String(subject)
  } catch {
    return String(subject)
  }
}

/** 截断，并且**先脱敏**再截断（脱敏函数认的是原文） */
function clip(text, max) {
  const safe = safeRedact(text)
  return safe.length > max ? `${safe.slice(0, max)}…` : safe
}

/** 脱敏，失败就当原文（脱敏自己挂了也不能连累记录） */
function safeRedact(text) {
  const value = typeof text === 'string' ? text : toText(text)
  try {
    return redact(value)
  } catch {
    return value
  }
}

/**
 * 分类。调用方已经分过类就把结果传进来（省一次匹配，也保证两边一致）。
 * 分类器自己要是不认识这个错，退成 `unknown` —— 那也比丢了强。
 */
function classifyOf(text, context) {
  if (context.kind) {
    return {
      kind: String(context.kind),
      needsUser: context.needsUser === true,
      retryable: context.retryable === true,
    }
  }
  try {
    const info = errorsCore.classify(text)
    return { kind: info.kind, needsUser: info.needsUser === true, retryable: info.retryable === true }
  } catch {
    return { kind: 'unknown', needsUser: false, retryable: false }
  }
}

/** 本地日期（和 data/logs 的命名一致），用来分文件 */
function dayOf(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 合并签名：同一来源、同一分类、同一位置、同一句话 = 同一条 */
function signatureOf(entry) {
  return [entry.source, entry.kind, entry.location || '', entry.message].join('|')
}

/** 凑一条记录 */
function build(subject, context) {
  const now = Date.now()
  const message = clip(toText(subject), MAX_TEXT)
  const classified = classifyOf(message, context)
  const rawText = context.raw === undefined ? '' : toText(context.raw)
  return {
    ts: new Date(now).toISOString(),
    kind: classified.kind,
    source: String(context.source || 'kernel'),
    message,
    raw: rawText ? clip(rawText, MAX_RAW) : '',
    location: context.location ? clip(context.location, 200) : '',
    needsUser: classified.needsUser,
    retryable: classified.retryable,
    hint: context.hint ? clip(context.hint, 300) : '',
    tool: context.tool ? clip(context.tool, 100) : '',
    taskId: context.taskId ? clip(context.taskId, 100) : '',
    sessionId: context.sessionId ? clip(context.sessionId, 100) : '',
    repeat: 1,
  }
}

/** 写进内存环形缓冲；返回是否「成功收下」 */
function keep(entry) {
  state.entries.push(entry)
  if (state.entries.length > MAX_BUFFER) {
    state.entries.shift()
    state.stats.dropped += 1
  }
  state.pending.push(entry)
  if (state.pending.length > MAX_BUFFER) {
    /* 盘写不进去的时候别把内存也撑爆（丢最旧的，计数在 stats.dropped） */
    state.pending.shift()
    state.stats.dropped += 1
  }
}

/**
 * 记一条。
 *
 * @param subject 错误本身（Error 或字符串）
 * @param context {source, location, kind, tool, taskId, sessionId, raw, hint}
 * @returns 记下的那条（没记则 null）——**调用方不需要看返回值**
 */
function record(subject, context) {
  try {
    if (!state.enabled) return null
    const ctx = context || {}
    state.stats.recorded += 1

    const entry = build(subject, ctx)
    if (!entry.message && !entry.raw) return null

    /*
     * 同一签名短期内重复：**只涨计数**，不写新行。
     * 但计数到 2/4/8/16…（2 的幂）时补写一行带累计数的，
     * 这样「同一个错刷了 1000 次」在文件里大约是 10 行而不是 1000 行，
     * 又不会像彻底去重那样把「它还在发生」这件事藏起来。
     */
    const key = signatureOf(entry)
    const seen = state.seen.get(key)
    if (seen && Date.now() - seen.at < DEDUP_MS) {
      seen.count += 1
      state.stats.repeats += 1
      if ((seen.count & (seen.count - 1)) === 0) {
        entry.repeat = seen.count
        keep(entry)
        if (state.pending.length >= BURST) flush()
      }
      return entry
    }

    state.seen.set(key, { at: Date.now(), count: 1 })
    if (state.seen.size > MAX_SIGNATURES) {
      /* 表满了丢最早的一个（Map 保插入序） */
      state.seen.delete(state.seen.keys().next().value)
    }

    keep(entry)
    if (state.pending.length >= BURST) flush()
    return entry
  } catch {
    state.stats.failed += 1
    return null
  }
}

/** 落盘。返回这次写了几条（失败返回 0，并把计数记下 —— 不抛） */
function flush() {
  try {
    if (!state.enabled) return 0
    if (!state.pending.length || !state.dir) return 0
    const lines = state.pending.map((entry) => `${JSON.stringify(entry)}\n`).join('')
    fs.mkdirSync(state.dir, { recursive: true })
    const file = path.join(state.dir, `${dayOf(Date.now())}.jsonl`)
    /*
     * 整行再过一次脱敏：字段进来时已经脱过一次，这里防的是
     * 「密钥出现在两段拼接处」这类漏网。代价可以忽略（出错本来就少）。
     */
    fs.appendFileSync(file, safeRedact(lines), 'utf8')
    const count = state.pending.length
    state.stats.written += count
    state.pending.length = 0
    return count
  } catch {
    state.stats.failed += 1
    return 0
  }
}

/** 定时器一律 unref：绝不能因为观察哨让进程不退出 */
function startTimer() {
  if (state.timer) return
  state.timer = setInterval(() => flush(), FLUSH_MS)
  if (typeof state.timer.unref === 'function') state.timer.unref()
}

/**
 * 打开观察哨（真跑应用时由 main.cjs 调，**自检不调**）。
 * 重复调用没事；出任何岔子就保持关闭状态。
 */
function install(options) {
  try {
    const opts = options || {}
    state.dir = opts.dir || DIRS.errors
    state.enabled = true
    startTimer()
    /*
     * 定时器是 unref 的（不能让观察哨拦住进程退出），代价是「退出前那一下丢东西」
     * —— 所以再挂一道退出闸：`exit` 里只能跑同步代码，而落盘用的就是 appendFileSync，正好。
     */
    process.once('exit', () => flush())
    return { ok: true, dir: state.dir, flushMs: FLUSH_MS }
  } catch {
    state.enabled = false
    return { ok: false, dir: '', flushMs: FLUSH_MS }
  }
}

/** 关掉：先把攒着的写下去，再撤定时器 */
function dispose() {
  try {
    flush()
    if (state.timer) clearInterval(state.timer)
    state.timer = null
    state.enabled = false
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** 给测试和「关于」面板看的状态 */
function stats() {
  return {
    enabled: state.enabled,
    dir: state.dir,
    buffered: state.entries.length,
    pending: state.pending.length,
    signatures: state.seen.size,
    ...state.stats,
  }
}

/** 内存里最近的记录（测试用；不读文件） */
function recent(limit) {
  const n = Math.max(0, Number(limit) || 10)
  return state.entries.slice(-n)
}

module.exports = { record, flush, install, dispose, stats, recent }
