/**
 * 结构化记忆：词汇表与记录形状
 *
 * 一条记忆是一个对象：
 *
 *   content      内容（一句话，用户能看懂）
 *   type         preference / fact / workflow / project_rule / constraint /
 *                decision / temporary / habit / instruction
 *   scope        global / project / workspace / task / session
 *   source       user_explicit / user_confirmed / model_suggested / imported / system
 *   confidence   0..1
 *   importance   0..1（检索排序用）
 *   status       active / superseded / disabled / expired
 *   supersededBy 被哪条取代（保留历史，但不再注入）
 *
 * 这一个文件只管「合法值有哪些」和「小工具」，
 * 真正读写 JSON 的是 memory-store.cjs。
 */

const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const redact = require('./redact.cjs')

const TYPES = [
  'preference',
  'fact',
  'workflow',
  'project_rule',
  'constraint',
  'decision',
  'temporary',
  'habit',
  'instruction',
]

const SCOPES = ['global', 'project', 'workspace', 'task', 'session']
const SOURCES = ['user_explicit', 'user_confirmed', 'model_suggested', 'imported', 'system']
const STATUSES = ['active', 'superseded', 'disabled', 'expired']

function filePath() {
  return path.join(DIRS.data, 'memory.json')
}

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 看起来像密钥的内容不许进记忆。
 *
 * 模式表**只有一处**：`redact.cjs` 的 PATTERNS（外加凭证库里登记过的真 key）。
 *
 * 这里以前自己拄了一张 5 条的窄表（只认 sk- / gh[pousr]_ / AKIA / 私钥块 / Bearer），
 * 而脱敏那张表宽得多。后果（只读审计 + 实测）：`github_pat_…`、`AIza…`（Google）、
 * `xoxb-…`（Slack）、`hf_…`（HuggingFace）、JWT、`api_key=xxx`、`password: xxx`
 * 七类都能写进记忆 —— 而记忆是**每轮注入上下文**的，漏一条就是每轮都泄露 + 进备份。
 *
 * ★ 判据**只有一处**（2026-10-04 统一）：`redact.looksSecret()`。它就是
 *   「原文 vs 过一遍主入口」的对比，加新厂商前缀只改 `redact.cjs` 那张模式表。
 *   以前这里**又写了一遍**同样的对比 —— 两处逻辑一模一样就是两个会漂的真相源
 *   （第三处 `diagnostics.scrubLogLine` 已经在上一轮改成 `redact()`）。
 *   名字保持不变：`memory-store` 与 `schedule-store` 照旧引 `looksLikeSecret`。
 */
const looksLikeSecret = redact.looksSecret

/** 下一个序号（取文件里最大的 +1） */
function nextSeq(data) {
  let max = 0
  for (const item of data.items) {
    if (Number.isFinite(item.seq) && item.seq > max) max = item.seq
  }
  return max + 1
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function limitFromConfig() {
  try {
    return require('./config.cjs').get().memory.maxItems
  } catch {
    return 800
  }
}

module.exports = {
  TYPES,
  SCOPES,
  SOURCES,
  STATUSES,
  looksLikeSecret,
  filePath,
  newId,
  nextSeq,
  clamp,
  limitFromConfig,
}
