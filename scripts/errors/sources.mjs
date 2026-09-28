/**
 * 读五类数据源 → 归一化的「候选错误」。
 *
 * 全部**只读**：这个模块不许写任何文件（导出报告是 CLI 的事，且不许写进 data/）。
 *
 * 设计要点（都是从真实数据摸出来的，不是猜的）：
 *   · logs：`[时间] [ERROR] 消息`，一天一个文件
 *   · audit：一行一条 JSON，字段 ts/sessionId/taskId/tool/args/ok/error/...
 *   · tasks：`data/tasks/<id>.json` 是任务明细（有 steps/errors/status），`_index.json` 是索引
 *   · events：一行一条 JSON，字段 eventId/taskId/timestamp/type/payload
 *   · sessions：一行一条 JSON（首行 type=meta），会话里出错会带 error/errors 字段
 *
 * 时间过滤按**文件 mtime**先粗筛（390 个会话文件、15 个审计文件不能全读），
 * 再按记录自己的时间戳精筛 —— 这样默认 `--since=24h` 的扫描是秒级的。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一次扫描能读的最大字节数（防止某个超大文件把工具拖死） */
const MAX_BYTES = 8 * 1024 * 1024

const readIfFresh = (file, sinceMs) => {
  try {
    const st = fs.statSync(file)
    if (st.mtimeMs < sinceMs) return null
    if (st.size > MAX_BYTES) return null /* 超大的跳过并让调用方记账 */
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const listFiles = (dir, ext) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean)

/** 从 `[2026-09-29T03:40:37.192+08:00] [ERROR] 消息` 里取时间与消息 */
const LOG_RE = /^\[([^\]]+)\]\s*\[(ERROR|WARN)\]\s*(.*)$/

/**
 * 内核日志。只取 ERROR（WARN 太吵，且多数是设计内的降级），
 * 但把 WARN 的条数单独数出来交给调用方展示 —— 不藏数据。
 */
export function scanLogs(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'logs')
  const items = []
  const skipped = []
  let warnCount = 0

  for (const file of listFiles(dir, '.log')) {
    const text = readIfFresh(file, sinceMs)
    if (text === null) {
      skipped.push(path.basename(file))
      continue
    }
    for (const line of lines(text)) {
      const m = line.match(LOG_RE)
      if (!m) continue
      const [, stamp, level, message] = m
      if (level === 'WARN') {
        warnCount += 1
        continue
      }
      const ts = Date.parse(stamp)
      if (Number.isFinite(ts) && ts < sinceMs) continue
      items.push({
        source: 'log',
        ts: Number.isFinite(ts) ? ts : sinceMs,
        message,
        raw: line,
        location: path.basename(file),
        context: { taskId: null, sessionId: null, tool: null },
      })
    }
  }
  return { items, skipped, warnCount }
}

/** 审计日志：一行一条 JSON；只取 ok=false */
export function scanAudit(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'audit')
  const items = []
  const skipped = []

  for (const file of listFiles(dir, '.jsonl')) {
    const text = readIfFresh(file, sinceMs)
    if (text === null) {
      skipped.push(path.basename(file))
      continue
    }
    for (const line of lines(text)) {
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (o.ok !== false) continue
      const ts = Number(o.ts ?? o.finishedAt ?? 0) || sinceMs
      if (ts < sinceMs) continue
      items.push({
        source: 'audit',
        ts,
        message: String(o.error ?? '').trim() || '（审计里 ok=false，但没写 error 文本）',
        raw: line.slice(0, 600),
        location: `audit:${o.tool ?? '?'}`,
        context: {
          taskId: o.taskId || null,
          sessionId: o.sessionId || null,
          tool: o.tool || null,
          args: o.args ?? null,
          affectedFiles: o.affectedFiles ?? null,
        },
      })
    }
  }
  return { items, skipped }
}

/** 任务台账：`<id>.json` 明细里的 status=failed / errors[] / steps[].error */
export function scanTasks(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'tasks')
  const items = []
  const skipped = []

  for (const file of listFiles(dir, '.json')) {
    if (path.basename(file) === '_index.json') continue
    const text = readIfFresh(file, sinceMs)
    if (text === null) {
      skipped.push(path.basename(file))
      continue
    }
    let t
    try {
      t = JSON.parse(text)
    } catch {
      continue
    }
    const ts = Number(t.updatedAt ?? t.createdAt ?? 0) || sinceMs
    if (ts < sinceMs) continue
    const base = {
      source: 'task',
      ts,
      location: `task:${t.id}`,
      context: { taskId: t.id ?? null, sessionId: t.sessionId ?? null, tool: null, status: t.status },
    }
    if (t.status === 'failed') {
      items.push({ ...base, message: `任务失败：${t.title || t.id}${t.pauseReason ? `（${t.pauseReason}）` : ''}`, raw: JSON.stringify({ status: t.status, pauseReason: t.pauseReason }) })
    }
    for (const e of Array.isArray(t.errors) ? t.errors : []) {
      items.push({ ...base, message: String(e?.message ?? e ?? '（任务里记了一条错误，没有 message）'), raw: JSON.stringify(e).slice(0, 400) })
    }
    for (const [i, s] of (Array.isArray(t.steps) ? t.steps : []).entries()) {
      if (s?.ok === false || s?.status === 'failed' || s?.error) {
        items.push({
          ...base,
          location: `task:${t.id}.steps[${i}]`,
          message: String(s.error ?? s.summary ?? `步骤 ${i + 1} 失败`),
          raw: JSON.stringify(s).slice(0, 400),
          context: { ...base.context, tool: s.tool ?? null, step: i + 1 },
        })
      }
    }
  }
  return { items, skipped }
}

/** 事件流：agent.failed / agent.retrying 这类失败信号 */
export function scanEvents(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'events')
  const items = []
  const skipped = []
  const FAIL_TYPES = new Set(['agent.failed', 'agent.retrying', 'agent.aborted', 'agent.error'])

  for (const file of listFiles(dir, '.jsonl')) {
    const text = readIfFresh(file, sinceMs)
    if (text === null) {
      skipped.push(path.basename(file))
      continue
    }
    for (const line of lines(text)) {
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!FAIL_TYPES.has(o.type)) continue
      const ts = Number(o.timestamp ?? 0) || sinceMs
      if (ts < sinceMs) continue
      const p = o.payload ?? {}
      items.push({
        source: 'event',
        ts,
        message: `${o.type}${p.attempt ? `（第 ${p.attempt} 次尝试）` : ''}${p.reason ? `：${p.reason}` : ''}`,
        raw: line.slice(0, 400),
        location: `event:${o.type}`,
        context: { taskId: o.taskId ?? null, sessionId: p.sessionId ?? null, tool: p.tool ?? null, eventType: o.type },
      })
    }
  }
  return { items, skipped }
}

/** 会话：一行一条 JSON，出错的行通常带 error / errors 字段 */
export function scanSessions(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'sessions')
  const items = []
  const skipped = []
  let scanned = 0

  for (const file of listFiles(dir, '.jsonl')) {
    const text = readIfFresh(file, sinceMs)
    if (text === null) {
      skipped.push(path.basename(file))
      continue
    }
    scanned += 1
    const sessionId = path.basename(file, '.jsonl')
    for (const line of lines(text)) {
      /* 先做便宜的字符串筛，再解析（390 个文件不能全 JSON.parse） */
      if (!/"(error|errors|errorKind|failed)"\s*:/.test(line)) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      const err = o.error ?? o.errors
      if (!err) continue
      const ts = Number(o.ts ?? o.timestamp ?? o.at ?? 0) || sinceMs
      if (ts < sinceMs) continue
      const text2 = typeof err === 'string' ? err : JSON.stringify(err)
      items.push({
        source: 'session',
        ts,
        message: text2.slice(0, 300),
        raw: line.slice(0, 400),
        location: `session:${sessionId}`,
        context: { taskId: o.taskId ?? null, sessionId, tool: o.tool ?? null, errorKind: o.errorKind ?? null },
      })
    }
  }
  return { items, skipped, scanned }
}
