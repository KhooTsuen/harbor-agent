/**
 * 扫描编排：把五类数据源扫出来 → 分类 → 打噪音标签 → 去重聚合 → 汇总。
 *
 * **只读**（这个模块一个写文件的地方都没有）。
 * `scripts/scan-errors.mjs` 是它的入口；CLI（`scripts/errors.mjs`）调它。
 */
import path from 'node:path'
import { scanLogs, scanAudit, scanTasks, scanEvents, scanSessions, scanObserver } from './errors/sources.mjs'
import { judge, lowTrust, hasDataDir } from './errors/noise.mjs'
import { classify, classifierAvailable, severityOf, hintOf, locationOf, dedupeKey, aggregate } from './errors/severity.mjs'

/** 把 `24h` / `7d` / `30m` / ISO 时间 解析成毫秒时间戳 */
export function parseSince(input, now = Date.now()) {
  if (!input) return now - 24 * 3600 * 1000
  const m = String(input).trim().match(/^(\d+)\s*([mhd])$/i)
  if (m) {
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86_400_000
    return now - n * ms
  }
  const ts = Date.parse(String(input))
  if (Number.isFinite(ts)) return ts
  throw new Error(`看不懂的时间：${input}（支持 24h / 7d / 90m / 2026-09-29T00:00:00+08:00）`)
}

/**
 * 扫一遍。
 * @param {{dataDir?: string, since?: number, includeNoise?: boolean}} options
 */
export function scan({ dataDir = path.resolve(import.meta.dirname, '..', 'data'), since = Date.now() - 86_400_000 } = {}) {
  const started = Date.now()
  if (!hasDataDir(dataDir)) {
    return { ok: false, reason: `没有数据目录：${dataDir}`, entries: [], stats: { total: 0 } }
  }

  const logs = scanLogs(dataDir, since)
  const audit = scanAudit(dataDir, since)
  const tasks = scanTasks(dataDir, since)
  const events = scanEvents(dataDir, since)
  const sessions = scanSessions(dataDir, since)
  /* 观察哨自己的输出（内核 error-observer.cjs）：内核在 catch 里看到的第一手错误 */
  const observed = scanObserver(dataDir, since)

  const raw = [
    ...logs.items,
    ...audit.items,
    ...tasks.items,
    ...events.items,
    ...sessions.items,
    ...observed.items,
  ]

  const entries = []
  const noise = []
  const denied = []
  for (const item of raw) {
    const verdict = judge(item)
    if (verdict.verdict === 'noise') {
      noise.push({ ...item, reason: verdict.reason })
      continue
    }
    /*
     * 观察哨记的那条**已经在内核里分过类**（它的 catch 里就是调 errors.cjs）——
     * 直接用它给的 kind，别在读取侧重猜：分类器只有一份，猜两次就会出现两个说法。
     * 其他来源没有这个字段，照旧走 classify()。
     */
    const info = item.kind
      ? {
          kind: item.kind,
          needsUser: item.needsUser === true,
          retryable: item.retryable === true,
          hint: item.hint ?? '',
        }
      : classify(item.message, { source: item.source })
    const isDenied = verdict.verdict === 'expected_denial'
    const entry = {
      source: item.source,
      ts: item.ts,
      kind: info.kind,
      severity: severityOf(info.kind, {
        needsUser: info.needsUser,
        retryable: info.retryable,
        denied: isDenied,
        message: item.message,
      }),
      message: String(item.message).slice(0, 400),
      location: locationOf(item),
      context: item.context ?? {},
      raw: item.raw ?? '',
      /* 观察哨把「同一个错反复发生」折叠成一行 + repeat 计数，这里要把数找回来 */
      repeat: Number(item.repeat) || 1,
      hint: hintOf(info.kind, item.message, info.hint ?? ''),
      retryable: Boolean(info.retryable),
      needsUser: Boolean(info.needsUser),
      denied: isDenied,
      lowTrust: lowTrust(item),
    }
    entry.key = dedupeKey(entry.kind, { ...item, message: entry.message })
    ;(isDenied ? denied : entries).push(entry)
  }

  const grouped = aggregate(entries)
  const groupedDenied = aggregate(denied)

  const bySource = {}
  const byKind = {}
  for (const e of grouped) {
    bySource[e.source] = (bySource[e.source] ?? 0) + e.count
    byKind[e.kind] = (byKind[e.kind] ?? 0) + e.count
  }

  return {
    ok: true,
    dataDir,
    since,
    classifierAvailable,
    entries: grouped.filter((e) => e.kind !== 'retry'),
    retries: grouped.filter((e) => e.kind === 'retry'),
    denied: groupedDenied,
    noise: { count: noise.length, byReason: countBy(noise.map((n) => n.reason)), samples: noise.slice(0, 5) },
    stats: {
      raw: raw.length,
      real: grouped.filter((e) => e.kind !== 'retry').reduce((n, e) => n + e.count, 0),
      unique: grouped.filter((e) => e.kind !== 'retry').length,
      retries: grouped.filter((e) => e.kind === 'retry').reduce((n, e) => n + e.count, 0),
      denied: groupedDenied.reduce((n, e) => n + e.count, 0),
      bySource,
      byKind,
      bySeverity: countBy(grouped.filter((e) => e.kind !== 'retry').map((e) => e.severity)),
      warnCount: logs.warnCount,
      scanned: {
        sessions: sessions.scanned ?? 0,
        skippedFiles:
          logs.skipped.length +
          audit.skipped.length +
          tasks.skipped.length +
          events.skipped.length +
          sessions.skipped.length +
          observed.skipped.length,
      },
      elapsedMs: Date.now() - started,
    },
  }
}

/* 合并（count / firstSeen / lastSeen）用的是内核那份（`error-rules.cjs` 的 aggregate，
   经 severity.mjs 转发过来）—— 界面走的是同一个函数，两边口径不会不一样。 */

const countBy = (list) => {
  const out = {}
  for (const v of list) out[v] = (out[v] ?? 0) + 1
  return out
}
