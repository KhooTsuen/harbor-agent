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

/**
 * 读时规整一条记忆（轻量迁移，不改文件）：补 `sessionId` / `projectId` 空串。
 *
 * `sessionId` 是 2026-10-11 为 SEC-065 加的字段 —— 老记录里没有它。补空串等于
 * 「没有会话归属」，检索会话作用域时不会被注入（fail-closed），既不丢老数据、
 * 也不把会话私有内容漏到别的会话。**不写回文件**：只在读出来时补默认值，
 * 真正落盘由下一次 add/update 正常带出。
 */
function normalizeItem(item) {
  return {
    ...item,
    projectId: typeof item.projectId === 'string' ? item.projectId : '',
    sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
  }
}

/**
 * 「库里这条和这次要写的，是不是**同一条**记忆」—— `add` 的去重判据（要判重的地方只准用这一处）。
 *
 * 三个键：内容 + scope + 归属（projectId / sessionId）。
 *
 * ★ 为什么 scope 和归属必须进这个键（2026-11-05 实测修）：以前只比内容，于是
 *
 *   · `remember(scope=session)` 一条**已经作为 global 存在**的内容 → 回 deduped，
 *     库里仍是那条 global：用户明确要求的「只在这个会话里生效」**建不起来**，
 *     而内容照样全局可见 —— 受限意图被降级成公开（SEC-065 那个方向）；
 *   · 设置页「新增记忆」选「项目」时同样只弹一句「这条已经记过了」。
 *
 *   `docs/Memory设计.md` §3 的口径是：scope 是**有效性语境**，不同 scope 的合法
 *   差异不叫冲突（User 用 pnpm、Project A 用 npm）。所以「同内容分别存在于
 *   global / project / session」是**设计允许的**，不是重复。
 *
 * ★ `type` 不进这个键：同内容 + 同 scope 只是换个类型，是同一句话被贴了两个标签，
 *   不是两件事。这种仍算「已经记过」，并且**不覆盖**原类型（覆盖 = 偷偷改语义），
 *   由 `remember` 如实告诉调用方「还是原来那个类型」（自检 207 ⑤）。
 *
 * ★ 已知限制：`workspace` / `task` 两种 scope **没有**对应的归属字段，
 *   只按「内容 + scope」比 —— 同一个工作目录 / 任务里的同内容记忆会互相去重。
 *
 * @param {{ status?: string, content?: string, scope?: string, projectId?: string, sessionId?: string }} item
 * @param {{ content: string, scope: string, projectId: string, sessionId: string }} wanted 已归一化（认不出的值已退回 global / 空串）
 * @returns {boolean}
 */
function sameEntry(item, wanted) {
  if (!item || item.status !== 'active') return false
  if (String(item.content ?? '').trim() !== wanted.content) return false
  if ((SCOPES.includes(item.scope) ? item.scope : 'global') !== wanted.scope) return false
  if (String(item.projectId ?? '') !== wanted.projectId) return false
  return String(item.sessionId ?? '') === wanted.sessionId
}

/**
 * 把 `add` 的入参归一化成「这条记忆的归属」—— 认不出的值退回 global / 空串。
 *
 * 为什么单独一个函数：`store.add` 要拿它①判重（`sameEntry`）②落库，两处必须是
 * **同一份**归一化结果。以前判重比的是原始 `input.scope`、落库比的是校验后的值，
 * 于是 `scope: 'bogus'` 这种输入在两边看到两个不同的 scope。
 *
 * @param {string} content
 * @param {{ scope?: string, projectId?: string, sessionId?: string }} input
 */
function wantedOf(content, input) {
  return {
    content,
    scope: SCOPES.includes(input.scope) ? input.scope : 'global',
    projectId: String(input.projectId ?? ''),
    sessionId: String(input.sessionId ?? ''),
  }
}

module.exports = {
  TYPES,
  SCOPES,
  SOURCES,
  STATUSES,
  looksLikeSecret,
  sameEntry,
  wantedOf,
  filePath,
  newId,
  nextSeq,
  normalizeItem,
  clamp,
  limitFromConfig,
}
