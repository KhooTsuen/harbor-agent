/**
 * 连续失败（CE-011 · P2「失败后生成替代方案」）
 *
 * 症结：同一个任务连着失败时，模型只会被反复「顶回」，而它换个法子再来、再失败，
 * **没有任何机制**会提醒它「这条路走不通，该换方案了」。
 *
 * 和 `loop-guard.cjs` 的分工（判据不同、可共存，别混）：
 *   · loop-guard    —— **同一个调用**在转圈（工具 + 参数一模一样）→ 改道
 *   · failure-streak —— **不同的尝试**连着失败                    → 生成替代方案
 * 同一轮里两者不重复推：调用方把「loop-guard 这轮推了没」当 `blocked` 传进来
 * （共用一个「本轮已推」标志，见下面 check 的第 ④ 条）。
 *
 * 判据**只读结构化事实**：`task.steps[].ok`（布尔，由 `loop-tools.cjs` 的
 * `isToolOk` 写台账前算好）—— **不解析任何自然语言**，与 `task-strict.cjs` 同口径。
 *
 * 刹车三条（照 `task-strict.cjs` 的先例）：
 *   ① 同一条失败期只推一次（按连续失败次数**快照去重**）；
 *   ② 每条失败期最多推 `MAX_PUSHES` 次；③ 非 `running` 的任务不管。
 * 顶够了就放行 —— 不能让模型被卡在这儿。
 *
 * `check` 的状态是**进程内的观察锚**（按 taskId 存；不是台账字段，不落盘、不改数据结构）。
 */

/** 连续失败几次就提醒（用户拍板：2 —— 比 3 更早止损） */
const THRESHOLD = 2
/** 同一条失败期里最多推几次（对照 task-strict 的 MAX_PUSHES = 3） */
const MAX_PUSHES = 3
/** 观察锚的条数上限（防长跑进程攒爆；超出丢最旧的一条） */
const SEEN_CAP = 100

/** taskId → { pushed: number[], pushes: number } */
const seen = new Map()

/**
 * 数「尾部连续的失败」。
 *
 * 跨工具也算 —— 模型换了个工具还是失败，那正是「这条路走不通」的信号，
 * 而不是「这个工具坏了」。遇到任何一次成功就停（那说明它有进展）。
 *
 * @param {{steps?: Array<{tool?: string, ok?: boolean, summary?: string}>}|null} task
 * @returns {{count: number, lastTool: string, lastHint: string}}
 */
function consecutiveFailures(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : []
  let count = 0
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.ok === false) count += 1
    else break
  }
  if (count === 0) return { count: 0, lastTool: '', lastHint: '' }
  const last = steps[steps.length - 1]
  return {
    count,
    lastTool: String(last?.tool ?? ''),
    lastHint: String(last?.summary ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 120),
  }
}

/**
 * 给模型的「换方案」提示（用户给的措辞，原样保留第一句）。
 * 单独一个函数：措辞会被自检钉住，不该散在循环里。
 */
function streakMessage({ count, lastTool, lastHint }) {
  const lines = [
    `这个任务已经连续失败 ${count} 次了。别再照原路子试。给出 2–3 个替代方案（换工具 / 换顺序 / 缩小范围 / 直接问用户），用 \`\`\`plan 块写清楚，再问我或自己挑一个试。`,
  ]
  if (lastTool) lines.push(`（最近一次是 \`${lastTool}\`${lastHint ? `：${lastHint}` : ''}）`)
  return lines.join('\n')
}

/** 忘掉某个任务的观察（换新任务 / 收尾时调；也给自检用来隔离） */
function reset(taskId) {
  if (taskId === undefined) seen.clear()
  else seen.delete(String(taskId))
}

/**
 * 轮次边界那一句：读台账、判该不该推，要推就塞进 messages。
 *
 * 照 `task-strict.pushStrictNote` 的先例写成「读 + 判 + 推」一步到位，
 * 免得调用方（`loop.cjs`）自己再去 require 一遍 `task.cjs`。
 *
 * @param {string} taskId
 * @param {Array<{role: string, content: string}>} messages
 * @returns {boolean} 推了没有（自检用得上）
 */
function pushNote(taskId, messages) {
  let task = null
  try {
    task = require('./task.cjs').get(String(taskId))
  } catch {
    /* 读台账失败 → 不推（宁可不提醒，也不能因为读不到把循环弄挂） */
    return false
  }
  const note = check({ task })
  if (!note) return false
  messages.push({ role: 'user', content: note })
  return true
}

/**
 * 轮次边界查一次：该不该推「换方案」。
 *
 * @param {{ task?: object|null, blocked?: boolean }} input
 *   `task`    台账里那条任务（`taskCore.get(taskId)`；null 就是没有任务）
 *   `blocked` 这一轮已经有别的机制推过了（loop-guard）→ 让一让，别重复推
 * @returns {string|null} 要推进对话的那句话；不用推就 null
 */
function check({ task = null, blocked = false } = {}) {
  const key = String(task?.id ?? '')
  if (!key) return null
  /* ③ 非 running 的任务不管（已经停了 / 在等用户） */
  if (task?.status !== 'running') {
    seen.delete(key)
    return null
  }
  const streak = consecutiveFailures(task)
  /* 失败期结束了（中间成功过）→ 清账，下一段失败期重新算 */
  if (streak.count < THRESHOLD) {
    seen.delete(key)
    return null
  }

  const record = seen.get(key) ?? { pushed: [], pushes: 0 }
  seen.set(key, record)
  /* ② 这条失败期已经推够次数了 → 放行 */
  if (record.pushes >= MAX_PUSHES) return null
  /* ① 同一个快照只推一次（同一个连续失败次数不重复推） */
  if (record.pushed.includes(streak.count)) return null
  /* ④ 与 loop-guard 共用「本轮已推」：它推了，这一轮就不推（**不记账**，下一轮还能推） */
  if (blocked) return null

  record.pushed.push(streak.count)
  record.pushes += 1
  if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value)
  return streakMessage(streak)
}

module.exports = { consecutiveFailures, streakMessage, check, pushNote, reset, THRESHOLD, MAX_PUSHES }
