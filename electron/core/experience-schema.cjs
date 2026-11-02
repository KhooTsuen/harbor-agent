/**
 * 经验（experience）：状态机、记录形状、阈值 —— **全项目唯一一份**
 *
 * ── 这一层和「记忆」不是一回事 ──
 *   · 记忆 = 用户 / 模型说的事（`memory-*`）。说错了也只是「记错了」。
 *   · 经验 = 系统在**真实执行里**观察到的「这样会失败、换那样就好了」。
 *     它会被注入到之后的提示里当建议，所以**一次失败绝不能直接变成规则** ——
 *     否则模型自己踩过的坑会变成它今后的「常识」，越错越自信。
 *
 * ── 状态机（蓝图 §5.1）──
 *
 *     candidate ──(独立验证达标)──▶ verified ──(有力反例)──▶ suspended
 *         │                            │                        │
 *         └──▶ rejected                └──▶ deprecated          └──▶ deprecated
 *
 * 几条刻意的取舍：
 *   ① `candidate` **永不注入**（没有这条，就等于「失败直接成规则」）。
 *   ② 升级要**独立**验证，且验证器得亲眼看过结果（见 `experience-verify.cjs`）。
 *   ③ 高风险类别（权限 / 外部阻塞 / 破坏性）**不自动升级** —— 蓝图 §7 要求人工批准，
 *      这一轮没有审批档位（留作下一切片），所以它们停在 candidate，不会被注入。
 *   ④ 反例只对 `verified` 生效，且立刻 `suspended`（停止注入、保留调查记录）。
 *
 * 文本 / 目标 / 做法签名那几件纯函数在 `experience-text.cjs`（那边解释了为什么搬）。
 */
const text = require('./experience-text.cjs')

/** 状态名 —— 别在别处写字面量 */
const STATUS = {
  CANDIDATE: 'candidate',
  VERIFIED: 'verified',
  SUSPENDED: 'suspended',
  DEPRECATED: 'deprecated',
  REJECTED: 'rejected',
}
const STATUSES = Object.values(STATUS)

/**
 * 允许的迁移。**只列能自动发生的**：
 *   · 升 `verified` 由验证计数驱动（且受 risk / 阈值约束）
 *   · 降 `suspended` 由反例或验证器版本失效驱动
 *   · `deprecated` / `rejected` 是**人**的结论（设置页 / 后续切片），这里只允许走到那儿
 * 没有 candidate → suspended：还没生效的东西谈不上「暂停使用」。
 */
const TRANSITIONS = {
  [STATUS.CANDIDATE]: [STATUS.VERIFIED, STATUS.REJECTED, STATUS.DEPRECATED],
  /*
   * `verified → rejected` 是**人**撤掉一条正在生效的经验。
   * 为什么必须有：审批档位给了人「批准」的权力，就必须给「反悔」的 ——
   * 否则批准一条错建议之后，唯一的挽回方式是等它自己踩到反例（可能永远等不到），
   * 或者手动删库。`suspended` 是**系统**判的（同类操作又失败），不能顶替人的撤回。
   */
  [STATUS.VERIFIED]: [STATUS.SUSPENDED, STATUS.REJECTED, STATUS.DEPRECATED],
  /*
   * `suspended → verified` 只允许**人**做（`experience-approve.restore`）：
   * 反例是系统侧判的（同工具同目标又失败），但系统只看得到「这一次失败」，
   * 看不到「那次失败其实是因为别的原因」。人翻过调查记录之后推翻它是正当的 ——
   * 不给这条路，一条被误伤的经验就只能删掉（连调查记录一起丢）。
   * 恢复**不清零**：`contradictions` 保留、验证次数不重置，再出同类反例立刻打停。
   */
  [STATUS.SUSPENDED]: [STATUS.VERIFIED, STATUS.REJECTED, STATUS.DEPRECATED],
  [STATUS.DEPRECATED]: [],
  [STATUS.REJECTED]: [],
}

/** 只有这个状态的条目会进提示（注入入口只认这一处判据） */
const INJECTABLE = new Set([STATUS.VERIFIED])

/** 独立成功验证达标的门槛（蓝图 §5.1：3 次独立成功；仅用于低风险建议） */
const VERIFY_THRESHOLD = 3

/** 「同一件事的修法」窗口：候选出现后多久内的成功才算它的验证（毫秒） */
const VERIFY_WINDOW_MS = 48 * 3600 * 1000

/** 库里最多留多少条（超了先清 rejected / deprecated 最旧的） */
const MAX_ITEMS = 200

/** 注入：最多几条、总字数上限（每轮都进提示，不能长） */
const INJECT_LIMIT = 3
const INJECT_MAX_CHARS = 600

/** 匹配命中门槛（0..1）；`domain` 只加权，**不做硬过滤**（蓝图 §5.2 跨领域） */
const MATCH_THRESHOLD = 0.45

/** 一次观察原文最多留多少字（进库、进提示的都是这个长度） */
const MAX_TEXT = text.MAX_TEXT

/**
 * 可信验证器。**这一轮不建注册表**（用户明确留作下一切片），
 * 所以这里只有「系统侧的事实来源」这一种：真实工具执行的结果。
 * 版本一变，旧批准全部失效（蓝图 §8）—— 由 `checkValidator()` 判。
 */
const VALIDATOR = { id: 'tool_outcome', version: 1 }

/**
 * 高风险类别：**不自动升级**，也不在别的状态间自动迁移。
 * 口径来自 `tool-failure.CATEGORY_OF` 那张表（那里是分类的唯一来源）。
 */
const HIGH_RISK_CATEGORIES = new Set(['permission', 'external_blocked'])

/** 原因码里的高风险：人已经喊过停 / 边界挡住（见 riskOf） */
const HIGH_RISK_REASONS = new Set(['DENIED', 'PERMISSION'])

/** 用户纠正的识别词（纯词表，不调 LLM；命不中就一个字都不记） */
const CORRECTION_WORDS = [
  '不对',
  '不是这样',
  '不是这个意思',
  '错了',
  '搞错',
  '弄错',
  '别再',
  '不要这样',
  '我说过',
  '你理解错',
]

/** 这句话像不像在纠正我 */
function looksLikeCorrection(textValue) {
  const value = String(textValue ?? '')
  if (!value.trim() || value.length > 500) return false
  return CORRECTION_WORDS.some((word) => value.includes(word))
}

function newId() {
  return `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 状态能不能这么走（唯一判据；store 每次迁移都问它） */
function canMove(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * 类别 / 原因码 → 风险档。
 *
 * `DENIED`（用户拒绝了这次操作）和 `PERMISSION` 也算高风险：它们是**人已经喊过停**
 * 或**边界挡住**的事，这类「经验」不该由系统自己升格成建议（蓝图 §7 要求人工批准）。
 * 认不出的按 low —— 不因为它默默停住一条本来能用的经验。
 */
function riskOf(category, reasonCode = '') {
  if (HIGH_RISK_CATEGORIES.has(String(category ?? ''))) return 'high'
  if (HIGH_RISK_REASONS.has(String(reasonCode ?? ''))) return 'high'
  return 'low'
}

/**
 * 允许**自动升级**的类别。
 *
 * 白名单而不是黑名单，因为「自动升 verified」是这套机制里唯一会改变模型行为的动作：
 *   · `tool_failure` / `assertion_failed`：成败由系统侧观察（退出码、测试状态），
 *     同一做法被重复采用并核实，是真证据。
 *   · `user_correction`：**不在名单里**。用户说「不对」是最高权威的输入，但
 *     「该怎么做才对」只有人能定 —— 这一轮没有审批档位（下一切片），所以它停在
 *     candidate，绝不因为「之后碰巧成功了几次」就自动变成建议。
 *   · `external_blocked`（验证码 / 登录墙）：修法不在我们手里，同样不自动升。
 */
const AUTO_PROMOTE_CATEGORIES = new Set(['tool_failure', 'assertion_failed'])

/**
 * 这条经验在**某个作用域**下已经攒了几次验证。
 *
 * 为什么按 `projectId` 分组，而不是数 `verifications.length`：
 * 一个 global 经验在甲项目成功 2 次、乙项目成功 1 次 —— 那是两件互不相关的事，
 * 加起来当成 3 次就是「不同项目的验证次数串在一起」。阈值只认**同一个作用域内**。
 */
function verificationsIn(item, projectId) {
  const key = String(projectId ?? '')
  return (item?.verifications ?? []).filter((entry) => String(entry?.projectId ?? '') === key)
}

/**
 * 「这次验证是不是独立的一次」。
 *
 * 同一 `opportunityId`（同一次工具调用，含它的自动重试）只算一次 ——
 * 自动重试成功恰恰是「同一执行机会」，蓝图明确说它不计数。
 */
function isIndependent(verifications, opportunityId) {
  const id = String(opportunityId ?? '')
  if (!id) return false
  return !(verifications ?? []).some((item) => item.opportunityId === id)
}

/** 验证器版本变了 → 旧批准失效（蓝图 §8） */
function checkValidator(item, current = VALIDATOR) {
  return String(item?.validatorId ?? '') === current.id && Number(item?.validatorVersion) === current.version
}

/**
 * 「这条经验现在能不能进提示」—— **唯一判据**（match.pick 与 inject 都问它）。
 *
 * 三个条件：① 状态可注入（只有 `verified`）② 批准还在效：
 *   · 系统自动升上来的 → 看**验证器版本**（`checkValidator`）——
 *     验证器换了，那次的「独立核实」就不算数了（蓝图 §8）。
 *   · 人批准上来的（`approval.by === 'user'`）→ **不看验证器版本**。
 *     理由：验证器变的是「系统怎么观察工具结果」，而人批准的是「这条建议本身对不对」；
 *     用前者作废后者，等于让人批了之后随便改一行验证器代码就把它静默废掉。
 *     人的批准有自己的有效期语义：`approval` 里记着批准时的那句话（做法），
 *     界面上也一直看得见是谁、什么时候批的。
 * ③ 分类允许注入（`user_correction` 靠人批之后才进来，此时 status 已经是 verified）。
 *
 * @param {{ status?: string, validatorId?: string, validatorVersion?: number,
 *           approval?: { by?: string } | null }} item
 * @returns {boolean}
 */
function injectable(item) {
  if (!INJECTABLE.has(String(item?.status ?? ''))) return false
  if (item?.approval?.by === 'user') return true
  return checkValidator(item)
}

module.exports = {
  STATUS,
  STATUSES,
  TRANSITIONS,
  INJECTABLE,
  AUTO_PROMOTE_CATEGORIES,
  VERIFY_THRESHOLD,
  VERIFY_WINDOW_MS,
  MAX_ITEMS,
  MAX_TEXT,
  INJECT_LIMIT,
  INJECT_MAX_CHARS,
  MATCH_THRESHOLD,
  VALIDATOR,
  HIGH_RISK_CATEGORIES,
  HIGH_RISK_REASONS,
  CORRECTION_WORDS,
  looksLikeCorrection,
  newId,
  canMove,
  riskOf,
  verificationsIn,
  isIndependent,
  checkValidator,
  injectable,
  /* 文本 / 目标 / 做法：实现搬去 experience-text，这里保留入口（调用方不必改 import） */
  sanitize: text.sanitize,
  normalizeText: text.normalizeText,
  targetOf: text.targetOf,
  recipeOf: text.recipeOf,
  featureOf: text.featureOf,
}
