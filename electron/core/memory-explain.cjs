/**
 * 记忆：可解释性（打分权重 + 打分理由）
 *
 * 从 memory-recall.cjs 拆出来的。
 *
 * 为什么要有它：retrieve() 一直在算一个 score 并据它排序，但**分数和理由
 * 哪儿都不落** —— 用户看到「注入了 5 条」，完全不知道为什么是这 5 条、
 * 为什么另外 200 条没进来。
 *
 * 可解释的前提是「解释里的分就是排序用的分」，所以权重表只能有一份：
 * 搬到这里之后 memory-recall.cjs 只调用、不再复制 —— 复制了就会漂。
 *
 * 两条纪律：
 *   ① **不 require fs、不 require electron**（自检要能直接 require 它）
 *   ② **权重数值不许顺手调**：这里每个数字 = 拆出前的检索行为。
 *      改它等于改排序，得单独走一轮验证（见自检组 71-memory-explain）
 */

const { similarity } = require('./memory-similarity.cjs')

/** 打分权重（唯一来源） */
const WEIGHTS = {
  /** 范围：越具体越优先 */
  scope: { session: 5, task: 4, project: 3, workspace: 2, global: 1 },
  /** 类型：规则 / 约束比「事实」更该被遵守 */
  type: {
    constraint: 4,
    instruction: 3.5,
    project_rule: 3,
    preference: 2.5,
    decision: 2.2,
    workflow: 1.8,
    habit: 1.6,
    fact: 1,
    temporary: 0.4,
  },
  /** 重要度 / 可信度：乘各自的系数 */
  importance: 2,
  confidence: 1.5,
  /** 条目没写 confidence 时按 1 算（原行为） */
  confidenceDefault: 1,
  /** 新鲜度 1/(1+天数/30) 的系数 */
  freshness: 1,
  /** 与提问的关键词重合度（Jaccard）× 6 */
  overlap: 6,
  /** 范围 / 类型不认识时按 1 算（原行为） */
  fallback: 1,
  /** 没有提问时，重合度按 0.5 记（原行为） */
  noQueryOverlap: 0.5,
}

const DAY_MS = 24 * 60 * 60 * 1000
/** 新鲜度的时间尺度：30 天前的记忆掉到一半 */
const FRESHNESS_DAYS = 30
/** summarize() 的字数上限 —— 界面那一行只塞得下这么多 */
const MAX_SUMMARY = 40

/* ── 人话 ────────────────────────────────────────────────── */

const SCOPE_LABEL = {
  session: '本次会话',
  task: '当前任务',
  project: '本项目',
  workspace: '本工作区',
  global: '全局',
}
const SCOPE_DETAIL = '范围越具体越优先'
const SCOPE_UNKNOWN_LABEL = '范围没写'
const SCOPE_UNKNOWN_DETAIL = '范围不认识，按默认权重算'

/** 类型：标签和「为什么它该被优先」写在同一条，避免两处对不上 */
const TYPE_INFO = {
  constraint: { label: '约束', detail: '约束类记忆优先被遵守' },
  instruction: { label: '要求', detail: '用户明确要求过的事优先被遵守' },
  project_rule: { label: '项目规则', detail: '项目规则不该被绕过' },
  preference: { label: '偏好', detail: '偏好决定回答方式' },
  decision: { label: '已定方案', detail: '已定方案别反复推翻' },
  workflow: { label: '流程', detail: '流程类记忆能省来回' },
  habit: { label: '习惯', detail: '习惯影响默认做法' },
  fact: { label: '事实', detail: '事实类只作背景' },
  temporary: { label: '临时', detail: '临时记忆权重最低' },
}
const TYPE_UNKNOWN_LABEL = '未分类'
const TYPE_UNKNOWN_DETAIL = '类型不认识，按默认权重算'

/** 扁平的类型标签表（memory-recall 生成提示词时用的就是它） */
const TYPE_LABEL = {}
for (const [key, info] of Object.entries(TYPE_INFO)) TYPE_LABEL[key] = info.label

const OVERLAP_LABEL = '与本次提问相关'
const NO_QUERY_LABEL = '没有具体提问'
const NO_QUERY_DETAIL = '没有提问，重合度按基准 0.5 算（对每条记忆一样，不影响排序）'

/* ── 打分 ────────────────────────────────────────────────── */

/** 数字兜底：脏数据不许把分数变成 NaN（NaN 参与排序结果是不可预测的） */
function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 记下多久了：算分用天数，说人话用「今天 / N 天前」 */
function ageOf(createdAt, now) {
  const created = Number(createdAt)
  if (!Number.isFinite(created)) {
    return { days: 0, label: '时间未知', detail: '没记时间，按刚记下算' }
  }
  const days = (now - created) / DAY_MS
  if (days < 1) return { days, label: '比较新', detail: '今天记的' }
  if (days < 7) return { days, label: '比较新', detail: `${Math.floor(days)} 天前记的` }
  if (days < 30) return { days, label: '不算旧', detail: `${Math.floor(days)} 天前记的` }
  return { days, label: '有点旧', detail: `${Math.floor(days)} 天前记的` }
}

/**
 * 一条记忆的**每一项**加分，顺序与原实现完全一致。
 *
 * ⚠️ 浮点加法不满足结合律：顺序换了，总分最后几位就可能不同，
 * 于是「解释里的分」和「排序用的分」对不上。顺序不许动：
 * 范围 → 类型 → 重要度 → 可信度 → 新鲜度 → 重合度。
 *
 * @param {object} item
 * @param {{ query?: string, now?: number }} [options]
 */
function signals(item, { query = '', now = Date.now() } = {}) {
  const list = []
  const scope = item?.scope
  const type = item?.type

  list.push({
    key: 'scope',
    label: SCOPE_LABEL[scope] ?? SCOPE_UNKNOWN_LABEL,
    weight: WEIGHTS.scope[scope] ?? WEIGHTS.fallback,
    detail: SCOPE_LABEL[scope] ? SCOPE_DETAIL : SCOPE_UNKNOWN_DETAIL,
  })

  list.push({
    key: 'type',
    label: TYPE_INFO[type]?.label ?? TYPE_UNKNOWN_LABEL,
    weight: WEIGHTS.type[type] ?? WEIGHTS.fallback,
    detail: TYPE_INFO[type]?.detail ?? TYPE_UNKNOWN_DETAIL,
  })

  /*
   * 重要度 / 可信度：原来直接乘，脏条目不写这两个字段会算出 NaN。
   * 这里兜成 0 / 1（store.add 永远会写，所以只影响从老文件里读到的脏数据）。
   */
  const importance = numberOr(item?.importance, 0)
  list.push({
    key: 'importance',
    label: '重要度',
    weight: importance * WEIGHTS.importance,
    detail: `重要度 ${importance}`,
  })

  const confidence = numberOr(item?.confidence, WEIGHTS.confidenceDefault)
  list.push({
    key: 'confidence',
    label: '来源可信',
    weight: confidence * WEIGHTS.confidence,
    detail: `可信度 ${confidence}`,
  })

  const age = ageOf(item?.createdAt, now)
  list.push({
    key: 'freshness',
    label: age.label,
    weight: WEIGHTS.freshness / (1 + age.days / FRESHNESS_DAYS),
    detail: age.detail,
  })

  /* 原实现对「有没有提问」的判断是 `query ? ...`（非空字符串就算有）—— 别改成 trim */
  const hasQuery = Boolean(query)
  const overlap = hasQuery ? similarity(item?.content ?? '', query) : WEIGHTS.noQueryOverlap
  list.push({
    key: 'overlap',
    label: hasQuery ? OVERLAP_LABEL : NO_QUERY_LABEL,
    weight: overlap * WEIGHTS.overlap,
    detail: hasQuery ? `关键词重合 ${Math.round(overlap * 100)}%` : NO_QUERY_DETAIL,
  })

  return list
}

/** 只要分数（排序用）—— 不建 reasons，省一点 */
function scoreOf(item, options = {}) {
  let score = 0
  for (const part of signals(item, options)) score += part.weight
  return score
}

/**
 * 分数 + 理由。
 *
 * score 与 scoreOf() 用同一段累加逻辑、同一个顺序，所以必然完全相等 ——
 * 这就是「解释里的分就是排序用的分」的兑现方式。
 *
 * 只把**真起了作用**的项放进 reasons：权重为 0 的（比如重要度 0）不算 ——
 * 说一个 0 分项「起了作用」是假话。
 *
 * @param {object} item
 * @param {{ query?: string, now?: number }} [options]
 * @returns {{ score: number, reasons: Array<{ key: string, label: string, weight: number, detail: string }> }}
 */
function explain(item, options = {}) {
  let score = 0
  const reasons = []
  for (const part of signals(item, options)) {
    score += part.weight
    if (part.weight > 0) reasons.push(part)
  }
  return { score, reasons }
}

/* ── 一句话总结（给界面） ─────────────────────────────────── */

/** 一句话里先说什么：类型 → 范围 → 重要度 → 可信度 → 新鲜度 */
const SHORT_ORDER = ['type', 'scope', 'importance', 'confidence', 'freshness']

/** 各信号的短说法（类型 / 范围用自己的标签） */
const SHORT_LABEL = { importance: '重要度较高', confidence: '来源可信' }

function shortOf(reason) {
  if (reason.key === 'type') return `${reason.label}类`
  if (reason.key === 'scope') return `${reason.label}范围`
  return SHORT_LABEL[reason.key] ?? reason.label
}

/**
 * 一句话中文，例：'约束类 + 本次会话范围，且与本次提问相关'（≤ 40 字）
 *
 * @param {{ reasons?: Array }} [input]
 */
function summarize({ reasons } = {}) {
  const list = (Array.isArray(reasons) ? reasons : []).filter((r) => numberOr(r?.weight, 0) > 0)
  const main = SHORT_ORDER.map((key) => list.find((r) => r.key === key))
    .filter(Boolean)
    .slice(0, 2)
    .map(shortOf)

  const overlap = list.find((r) => r.key === 'overlap')
  let tail = ''
  if (overlap) tail = overlap.label === OVERLAP_LABEL ? '，且与本次提问相关' : `，${overlap.label}`

  const text = `${main.join(' + ')}${tail}`.replace(/^，/, '') || '综合分较高'
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) : text
}

module.exports = { WEIGHTS, explain, scoreOf, summarize, signals, TYPE_LABEL, SCOPE_LABEL }
