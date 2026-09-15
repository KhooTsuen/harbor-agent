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
 *   status       active / superseded / disabled
 *   supersededBy 被哪条取代（保留历史，但不再注入）
 *
 * 这一个文件只管「合法值有哪些」和「小工具」，
 * 真正读写 JSON 的是 memory-store.cjs。
 */

const path = require('node:path')
const { DIRS } = require('./paths.cjs')

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
const STATUSES = ['active', 'superseded', 'disabled']

function filePath() {
  return path.join(DIRS.data, 'memory.json')
}

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 看起来像密钥的内容不许进记忆 */
const SECRET_LIKE =
  /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,})/

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
  SECRET_LIKE,
  filePath,
  newId,
  nextSeq,
  clamp,
  limitFromConfig,
}
