/**
 * 「数据与用量」页的**计数**（2026-11-08）
 *
 * ── 为什么单独一条通道 ────────────────────────────────────────
 *
 * `DataPortPanel` 挂载时会调 `countData()`，它只为显示「当前 N 项」，
 * 但原来是这么拿的：
 *
 *   Promise.all([listSessions(), taskList({limit:200}), memoryList(),
 *                auditStats(90), listSkills()])
 *
 * 问题：**这些接口返回的是完整数据，而调用方只要 `.length`**。
 * 实测（Dev 现场，真实数据）：
 *
 *   session.list   965 ms  ← 4 个会话 / 79 MB，要整篇读来数消息条数
 *   task.list(200) 298 ms  ← 192 个任务 / 24 MB，逐个读任务本体
 *   audit.stats(90) 1938 ms ← 29 个文件 / 137.7 MB
 *   ─────────────────────────
 *   countData 冷启动 1985 ms，**主进程整个冻死 1877 ms**
 *
 * 而 `Promise.all` 对**同步函数**没有并发效果 —— 每个 handler 照样串行阻塞。
 *
 * 所以这里给出一条「只要数字」的路：数个数不需要读内容。
 *
 * ── 数字必须与各 list 一致 ────────────────────────────────────
 *
 * 差一两个看着无所谓，但用户会看到「当前 7 项」然后删了 7 项 —— 数字对不上
 * 就是信任问题。所以每一处都照抄对应 `list()` 的去留判据：
 *
 *   · 会话：`readdir` + 名字白名单 + **空文件不算**（`list()` 里 `lines.length === 0` 返回 null）
 *   · 任务：索引里 `!broken` 的条数（`list()` 跳过 broken 与文件没了的）
 *
 * ⚠️ 会话**不读消息条数**（那要整篇读 79 MB）—— 计数用不到它。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

/** 会话名的白名单（与 session-read 同一形状：`sess_` + 小写字母数字） */
const SESSION_RE = /^sess_[a-z0-9]+$/i

/**
 * 有几条会话（**不读正文**）。
 *
 * @returns {number}
 */
function sessionCount() {
  let names = []
  try {
    names = fs.readdirSync(DIRS.sessions)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    if (!SESSION_RE.test(id)) continue
    try {
      /* 空文件 = 不是一条会话（`list()` 里 `lines.length === 0` 就返回 null） */
      if (fs.statSync(path.join(DIRS.sessions, name)).size === 0) continue
    } catch {
      continue
    }
    n += 1
  }
  return n
}

/**
 * 有几条任务（走索引，**不读任务本体**）。
 *
 * @returns {number}
 */
function taskCount() {
  try {
    const index = require('./task-index.cjs').load()
    /* `list()` 跳过 broken（重建时解不开的空壳）—— 这里也一样 */
    return index.items.filter((item) => !item.broken).length
  } catch {
    return 0
  }
}

/**
 * 「数据与用量」页要的 5 个数。
 *
 * 审计那项**不在这里算**：它是唯一需要真读文件的（137.7 MB），
 * 走 `audit:stats` 的异步版（按天缓存，第二次 18 ms）。
 * 少一项就少一次整盘扫描。
 *
 * @returns {{ sessions: number, tasks: number, memory: number, skills: number }}
 */
function counts() {
  let memory = 0
  let skills = 0
  try {
    memory = require('./memory.cjs').list({ includeSuperseded: true }).length
  } catch {
    /* 读不到算 0（和面板原来的行为一致） */
  }
  try {
    skills = require('./skills.cjs').list().length
  } catch {
    /* 同上 */
  }
  return { sessions: sessionCount(), tasks: taskCount(), memory, skills }
}

module.exports = { counts, sessionCount, taskCount }
