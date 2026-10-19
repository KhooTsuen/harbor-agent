/**
 * 项目测试修复的**有限尝试预算**（2026-10-17 · 3B-3）
 *
 * 「改一次 → 还挂 → 再改一次」很容易变成无限循环：模型每次都说"这次一定行"。
 * 所以次数与耗时两种预算都在这里管，超了就停。
 *
 * ── ★ 三条硬规矩 ──────────────────────────────────────────────
 *
 *   ① **按 executionId 计账**。同一次失败的多次尝试归到一组；换了新的失败
 *      （新 executionId）就是新的一组 —— 不会因为上一次用完了就把这条堵死。
 *   ② **次数上限写死 3**。调用方可以要 1（默认）或 2、3；要 5 直接拒。
 *      为什么不让用户设更大：真机上见过"给它 10 次它就真的用 10 次"，
 *      每次都要人点审批，点到最后是闭眼点 —— 那比不修更危险。
 *   ③ **预算只减不增**。已经用掉的次数不会因为重新调用而清零；
 *      只有新的 executionId 才有新的额度。
 *
 * ── ★ 已实现 / 未实现（2026-10-17 校正，先前文件头声称「三种预算都在这里管」是错的）
 *
 *   · **次数预算**：已实现（`takeAttempt` 的 `BUDGET_ATTEMPTS`）。
 *   · **耗时预算**：已实现（`takeAttempt` 的 `BUDGET_TIME`，从第一次尝试起算）。
 *   · **模型调用费预算**：★ **未实现**。本模块不知道模型调用，也不读用量账本 ——
 *     真要加得先有「一次修复花了多少 token/多少钱」的来源，那是 3C 的事。
 *     在此之前**不要**对用户宣称"有费用上限"。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * 「还剩几次」是**纯计数判据**，自检可以喂假数据直接跑，不必真去改文件。
 *
 * ⚠️ 不 require electron。账本落 `DIRS.data/project-test-attempts.jsonl`。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 默认只试 1 次 */
const DEFAULT_ATTEMPTS = 1
/** 硬上限：谁也不能要更多 */
const HARD_MAX_ATTEMPTS = 3
/** 一次修复的总耗时预算（毫秒）—— 超过就当作耗尽 */
const DEFAULT_TOTAL_MS = 10 * 60 * 1000
/** 账本最多留多少行（环形裁剪） */
const MAX_LINES = 500

/** 账本文件（惰性取 DIRS） */
function file() {
  const { DIRS } = require('./paths.cjs')
  return path.join(DIRS.data, 'project-test-attempts.jsonl')
}

/** executionId 形状（会拼日志、参与过滤，必须是安全字符） */
function safeId(id) {
  const s = String(id ?? '')
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : ''
}

/** 读账本；坏行跳过（写一半是真会发生的） */
function readAll() {
  try {
    const text = fs.readFileSync(file(), 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const one = JSON.parse(t)
        if (one && typeof one === 'object' && one.executionId) out.push(one)
      } catch {
        /* 坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 某次失败已经用掉的尝试。
 *
 * @param {string} executionId
 * @returns {{ used: number, firstAt: number, elapsedMs: number, lastStatus: string }}
 */
function stateOf(executionId) {
  const id = safeId(executionId)
  if (!id) return { used: 0, firstAt: 0, elapsedMs: 0, lastStatus: '' }
  const mine = readAll().filter((x) => x.executionId === id)
  if (mine.length === 0) return { used: 0, firstAt: 0, elapsedMs: 0, lastStatus: '' }
  const firstAt = Math.min(...mine.map((x) => Number(x.at) || 0))
  return {
    used: mine.length,
    firstAt,
    elapsedMs: firstAt > 0 ? Date.now() - firstAt : 0,
    lastStatus: String(mine[mine.length - 1].afterStatus ?? ''),
  }
}

/** 把次数收进合法区间；给了非法值就退到默认（不猜用户想要更多） */
function clampAttempts(input) {
  const n = Number(input)
  if (!Number.isFinite(n)) return DEFAULT_ATTEMPTS
  const i = Math.round(n)
  if (i < 1) return 1
  if (i > HARD_MAX_ATTEMPTS) return HARD_MAX_ATTEMPTS
  return i
}

/**
 * 领一次尝试额度（**不落盘**；落盘在 finish）。
 *
 * @param {{ executionId: string, maxAttempts?: number, totalMs?: number, now?: number }} input
 * @returns {{ ok: boolean, code?: string, message?: string, attemptNo?: number, remaining?: number, maxAttempts?: number }}
 */
function takeAttempt(input) {
  const id = safeId(input?.executionId)
  if (!id) return { ok: false, code: 'BAD_ID', message: 'executionId 形状不合法' }

  const maxAttempts = clampAttempts(input?.maxAttempts)
  const totalMs = Number(input?.totalMs) > 0 ? Number(input.totalMs) : DEFAULT_TOTAL_MS
  const now = Number(input?.now) || Date.now()
  const st = stateOf(id)

  if (st.used >= maxAttempts) {
    return {
      ok: false,
      code: 'BUDGET_ATTEMPTS',
      message: `这次失败的修复次数已用完（${st.used}/${maxAttempts}）—— 不再自动尝试`,
      attemptNo: st.used,
      remaining: 0,
      maxAttempts,
    }
  }
  if (st.firstAt > 0 && now - st.firstAt > totalMs) {
    return {
      ok: false,
      code: 'BUDGET_TIME',
      message: `修复耗时已超预算（已 ${Math.round((now - st.firstAt) / 1000)}s，上限 ${Math.round(totalMs / 1000)}s）—— 停止`,
      attemptNo: st.used,
      remaining: Math.max(0, maxAttempts - st.used),
      maxAttempts,
    }
  }
  return {
    ok: true,
    attemptNo: st.used + 1,
    remaining: Math.max(0, maxAttempts - st.used - 1),
    maxAttempts,
  }
}

/** 追加一条尝试记录（追加写，不重写整份） */
function finishAttempt(entry) {
  const id = safeId(entry?.executionId)
  if (!id) return { ok: false, message: 'executionId 形状不合法' }
  const line = {
    at: Number(entry.at) || Date.now(),
    executionId: id,
    attemptNo: Number(entry.attemptNo) || 1,
    testId: String(entry.testId ?? ''),
    path: String(entry.path ?? ''),
    beforeStatus: String(entry.beforeStatus ?? ''),
    afterStatus: String(entry.afterStatus ?? ''),
    written: entry.written === true,
    cancelled: entry.cancelled === true,
    ms: Number(entry.ms) || 0,
  }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.appendFileSync(file(), `${JSON.stringify(line)}\n`, 'utf8')
    pruneLines()
    return { ok: true }
  } catch (error) {
    /* 记账失败不该让修复本身失败 —— 但宁可下次少给额度也别无声放过 */
    return { ok: false, message: `尝试记录写入失败：${String((error && error.message) || error)}` }
  }
}

/** 行数超了就整份重写成最近 MAX_LINES 行 */
function pruneLines() {
  try {
    const text = fs.readFileSync(file(), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length <= MAX_LINES) return
    fs.writeFileSync(file(), `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8')
  } catch {
    /* 裁剪失败不影响主流程 */
  }
}

module.exports = {
  DEFAULT_ATTEMPTS,
  HARD_MAX_ATTEMPTS,
  DEFAULT_TOTAL_MS,
  MAX_LINES,
  file,
  stateOf,
  clampAttempts,
  takeAttempt,
  finishAttempt,
}
