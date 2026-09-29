/**
 * 内核：错误清单读取器
 *
 * 只读 `data/errors/*.jsonl`（观察哨写的那些），给界面（右栏「错误」标签）用。
 * **只读** —— 这个模块不写、不删、不改任何文件。
 *
 * 和命令行（`scripts/errors.mjs`）的关系：
 *   · 命令行扫 **6 个来源**（日志 / 审计 / 任务 / 事件 / 会话 / 观察哨），
 *     因为它是「排查历史」用的，连自检噪音都要看得到；
 *   · 界面只看**观察哨这一路**，因为那是内核在出错第一现场记的、
 *     字段已经归一化过（kind / location / needsUser），而且**绝不会混进自检噪音**
 *     （`--self-test` 时不装观察哨，见 error-observer.cjs 顶部）。
 *   · 两边**共用规则**（严重性 / 去重 / 合并都在 `error-rules.cjs`）——
 *     来源可以不同，口径不能不同。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const rules = require('./error-rules.cjs')

/** 严重性从重到轻；档位和措辞都在 `error-rules.cjs` 里定义（命令行用同一份） */
const SEVERITY_ORDER = rules.SEVERITY_ORDER
const SEVERITY_LABEL = rules.SEVERITY_LABEL

/** 一次最多读几个文件 / 多少字节（一天一个文件，别为了看一眼把内存吃满） */
const MAX_FILES = 60
const MAX_BYTES = 8 * 1024 * 1024
/** 界面默认看最近几天 */
const DEFAULT_DAYS = 7

/** 文件名就是日期（观察哨按本地日期分文件）；只认这个形状，别的一律不碰 */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 列出要读的文件：按日期倒序，最多 MAX_FILES 个 */
function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => ({ name, m: FILE_RE.exec(name) }))
      .filter((x) => x.m)
      .map((x) => ({ name: x.name, day: x.m[1] }))
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, MAX_FILES)
  } catch {
    return [] /* 目录还不存在 = 还没有过错误，不是故障 */
  }
}

/** 一行 JSON → 一条候选记录（畸形行返回 null，调用方计数） */
function parseLine(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const ts = Date.parse(String(o.ts ?? ''))
  if (!Number.isFinite(ts)) return null
  const origin = String(o.source || 'kernel')
  return {
    source: 'observer',
    ts,
    origin,
    /* 写入侧已经分过类 → 直接采信，不在读取侧重猜（分类器只有一份） */
    kind: o.kind ? String(o.kind) : undefined,
    needsUser: o.needsUser === true,
    retryable: o.retryable === true,
    storedHint: o.hint ? String(o.hint) : '',
    repeat: Number(o.repeat) || 1,
    message: String(o.message || '（观察哨记了一条没带消息的错误）'),
    raw: String(o.raw || ''),
    location: `${origin}:${o.location || '（未指明）'}`,
    context: { tool: o.tool || '', taskId: o.taskId || '', sessionId: o.sessionId || '' },
  }
}

/**
 * 读并整理成界面能直接画的东西。
 *
 * @param {{dir?: string, days?: number, since?: number, limit?: number}} options
 * @returns {{ok: boolean, dir: string, entries: Array, stats: object, reason?: string}}
 */
function read(options = {}) {
  const started = Date.now()
  const dir = options.dir || DIRS.errors
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : DEFAULT_DAYS
  const since = Number.isFinite(options.since) ? options.since : Date.now() - days * 86_400_000
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 200

  const files = listFiles(dir)
  if (!files.length) {
    return {
      ok: true,
      dir,
      entries: [],
      stats: emptyStats(days, Date.now() - started),
    }
  }

  const items = []
  let lines = 0
  let badLines = 0
  let bytes = 0
  let filesRead = 0

  for (const file of files) {
    const full = path.join(dir, file.name)
    let text
    try {
      const size = fs.statSync(full).size
      if (bytes + size > MAX_BYTES) break
      bytes += size
      text = fs.readFileSync(full, 'utf8')
      filesRead += 1
    } catch {
      continue /* 读不到就跳过：一条都读不出来也不该让界面报错 */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      lines += 1
      const item = parseLine(line)
      if (!item) {
        badLines += 1
        continue
      }
      if (item.ts < since) continue
      items.push(item)
    }
  }

  const entries = []
  for (const item of items) {
    const info = item.kind
      ? { kind: item.kind, needsUser: item.needsUser, retryable: item.retryable, hint: item.storedHint }
      : rules.classify(item.message, { source: item.source })
    const entry = {
      key: '',
      kind: info.kind,
      severity: rules.severityOf(info.kind, {
        needsUser: info.needsUser,
        retryable: info.retryable,
        message: item.message,
      }),
      message: item.message.slice(0, 400),
      hint: rules.hintOf(info.kind, item.message, info.hint ?? ''),
      origin: item.origin,
      location: item.location,
      ts: item.ts,
      repeat: item.repeat,
      needsUser: Boolean(info.needsUser),
      retryable: Boolean(info.retryable),
      raw: item.raw.slice(0, 600),
      context: item.context,
    }
    entry.key = rules.dedupeKey(entry.kind, { source: 'observer', message: entry.message, location: entry.location })
    entries.push(entry)
  }

  /* 合并用的是内核那一份（命令行也用它）—— 次数、首次/最后一次两个口径一致 */
  const grouped = rules.aggregate(entries)
  const rank = (sev) => {
    const i = SEVERITY_ORDER.indexOf(sev)
    return i === -1 ? SEVERITY_ORDER.length : i
  }
  grouped.sort((a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count || b.lastSeen - a.lastSeen)

  const bySeverity = {}
  const byKind = {}
  const byOrigin = {}
  for (const e of grouped) {
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + e.count
    byKind[e.kind] = (byKind[e.kind] ?? 0) + e.count
    byOrigin[e.origin] = (byOrigin[e.origin] ?? 0) + e.count
  }

  return {
    ok: true,
    dir,
    severityOrder: SEVERITY_ORDER,
    severityLabel: SEVERITY_LABEL,
    entries: grouped.slice(0, limit),
    truncated: grouped.length > limit,
    stats: {
      days,
      files: filesRead,
      lines,
      badLines,
      filesTotal: files.length,
      raw: items.length,
      unique: grouped.length,
      total: grouped.reduce((n, e) => n + e.count, 0),
      bySeverity,
      byKind,
      byOrigin,
      windowFrom: grouped.length ? Math.min(...grouped.map((e) => e.firstSeen)) : null,
      windowTo: grouped.length ? Math.max(...grouped.map((e) => e.lastSeen)) : null,
      elapsedMs: Date.now() - started,
    },
  }
}

function emptyStats(days, elapsedMs) {
  return {
    days,
    files: 0,
    filesTotal: 0,
    lines: 0,
    badLines: 0,
    raw: 0,
    unique: 0,
    total: 0,
    bySeverity: {},
    byKind: {},
    byOrigin: {},
    windowFrom: null,
    windowTo: null,
    elapsedMs,
  }
}

module.exports = { read, SEVERITY_ORDER, SEVERITY_LABEL, DEFAULT_DAYS }
