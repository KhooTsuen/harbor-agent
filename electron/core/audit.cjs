/**
 * 工具调用审计
 *
 * 每次工具调用写一行 JSONL 到 `data/audit/YYYY-MM-DD.jsonl`：
 * 谁（哪个会话/任务）、调了什么、参数是什么、什么权限、用户批没批、
 * 花了多久、成功还是失败、动了哪些文件、访问了哪个网络目标。
 *
 * 两条铁律：
 *
 * ① **参数必须脱敏**。工具参数里经常混着密钥（写 .env、拼 URL、传 env）。
 *    过 `redact.scrub` 之后再落盘。
 *
 * ② **审计失败不能影响主流程**。磁盘满了、权限不对，工具调用该成功还是成功，
 *    只是少一条记录 —— 所以所有写入都吞异常，只往主日志丢一条 warn。
 *
 * 「可审计」的意义在于事后能回答：这个文件是谁改的、那条命令是谁批的、
 * 当时用的是哪档权限。所以宁可记多，不可不记。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const { scrub, redact } = require('./redact.cjs')
const log = require('./log.cjs')

const MAX_RESULT_CHARS = 2000

function dir() {
  return path.join(DIRS.data, 'audit')
}

function fileFor(day) {
  return path.join(dir(), `${day}.jsonl`)
}

function today(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10)
}

function enabled() {
  try {
    return require('./config.cjs').get().audit.enabled !== false
  } catch {
    return true
  }
}

/**
 * 记一条。
 *
 * @param {object} entry
 * @param {string} [entry.sessionId]
 * @param {string} [entry.taskId]
 * @param {string} entry.tool
 * @param {object} [entry.args]
 * @param {string} [entry.permission]   调用时的权限档
 * @param {boolean|null} [entry.approval] true=用户批了 false=拒了 null=不需要批
 * @param {boolean} [entry.ok]
 * @param {string} [entry.error]
 * @param {number} [entry.startedAt]
 * @param {number} [entry.finishedAt]
 * @param {string[]} [entry.affectedFiles]
 * @param {string} [entry.networkTarget]
 * @param {object} [entry.extras]     别的想记的（风险等级之类），也会脱敏
 */
function record(entry) {
  if (!enabled()) return { ok: false, skipped: true }

  const startedAt = Number(entry.startedAt) || Date.now()
  const finishedAt = Number(entry.finishedAt) || Date.now()

  const line = {
    ts: finishedAt,
    sessionId: String(entry.sessionId ?? ''),
    taskId: String(entry.taskId ?? ''),
    tool: String(entry.tool ?? 'unknown'),
    args: entry.args === undefined ? undefined : scrub(entry.args, 5),
    permission: String(entry.permission ?? ''),
    approval: entry.approval === undefined ? null : entry.approval,
    startedAt,
    finishedAt,
    ms: Math.max(0, finishedAt - startedAt),
    ok: entry.ok !== false,
    /* error / result 也要过脱敏 —— 工具结果里可能夹着密码之类的敏感值 */
    error: entry.error ? redact(String(entry.error).slice(0, 500)) : '',
    affectedFiles: Array.isArray(entry.affectedFiles)
      ? entry.affectedFiles.map((f) => String(f)).slice(0, 50)
      : [],
    networkTarget: entry.networkTarget ? String(entry.networkTarget).slice(0, 300) : '',
    result: entry.result ? redact(String(entry.result).slice(0, MAX_RESULT_CHARS)) : '',
    extras: entry.extras ? scrub(entry.extras, 4) : undefined,
  }

  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.appendFileSync(fileFor(today(finishedAt)), `${JSON.stringify(line)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    /* 审计写不进去不能让工具调用失败 */
    log.warn(`写审计失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: '写入失败（主流程不受影响）' }
  }
}

/** 有哪些天有记录 */
function days() {
  try {
    return fs
      .readdirSync(dir())
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.replace('.jsonl', ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * 读记录（默认今天）。
 *
 * @param {{ day?: string, limit?: number, sessionId?: string, tool?: string, onlyProblems?: boolean }} options
 */
function read({ day, limit = 200, sessionId = '', tool = '', onlyProblems = false } = {}) {
  const target = day || today()
  const file = fileFor(target)

  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }

  const out = []
  /* 从新到旧 */
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const item = JSON.parse(lines[i])
      if (sessionId && item.sessionId !== sessionId) continue
      if (tool && item.tool !== tool) continue
      if (onlyProblems && (item.ok || item.approval === false)) {
        if (item.ok) continue
      }
      out.push(item)
    } catch {
      /* 半行（写到一半崩了）跳过 */
    }
  }
  return out
}

/** 汇总：今天/最近 N 天的调用数、失败数、被拒数 */
function stats(daysBack = 7) {
  const list = days().slice(0, daysBack)
  let total = 0
  let failed = 0
  let denied = 0
  const byTool = {}

  for (const day of list) {
    for (const item of read({ day, limit: 100_000 })) {
      total += 1
      if (!item.ok) failed += 1
      if (item.approval === false) denied += 1
      byTool[item.tool] = (byTool[item.tool] ?? 0) + 1
    }
  }

  return { days: list.length, total, failed, denied, byTool }
}

/** 超过保留期的删掉 */
function prune() {
  let retention = 30
  try {
    retention = require('./config.cjs').get().audit.retentionDays ?? 30
  } catch {
    /* 用默认值 */
  }

  const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000
  let removed = 0

  for (const day of days()) {
    const ts = Date.parse(`${day}T00:00:00Z`)
    if (!Number.isFinite(ts) || ts >= cutoff) continue
    try {
      fs.unlinkSync(fileFor(day))
      removed += 1
    } catch {
      /* 删不掉就算了 */
    }
  }

  if (removed > 0) log.info(`审计日志清理：删了 ${removed} 天（保留 ${retention} 天）`)
  return { ok: true, removed }
}

function clear() {
  let removed = 0
  for (const day of days()) {
    try {
      fs.unlinkSync(fileFor(day))
      removed += 1
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true, removed }
}

module.exports = { record, read, days, stats, prune, clear, today, dir }
