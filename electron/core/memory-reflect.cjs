/**
 * 记忆：反射（Reflect）雏形 —— 把「同一件事被记过不止一次」归并成一句
 *
 * ── 和 Recall 的本质区别（这个文件存在的理由）──
 * `memory-recall.cjs` 交的是**条目**：一条一行、按分数排序、原文照抄，每轮都注入。
 * 这里交的是**综合结论**：把散落的多条归并成一句「这类活你以前踩过坑」，
 * 只在**新活的第一轮**注入（动手之前说一次，不是每轮都念）。
 *
 * ── 最容易写出来的假 Reflect，以及为什么不做 ──
 * 最省事的写法是把召回到的条目再列一遍 —— 那等于在同一个提示里说两遍同样的话：
 * 白烧 token、还稀释注意力（`memory-recall.cjs` 的文件头已经写过这个坑）。
 * 所以这里**只输出「≥ 2 条在说同一件事」的组**：只有一条的组不输出
 * （那本来就是 Recall 的活，而 Recall 每轮都在场）。归并出来的那句
 * 「这件事你反复记过 N 次」是**新信息**，不是原文的重复。
 *
 * ── 最小可行：不额外调模型、不引新依赖、不新建存储 ──
 * 归并用现成的 `similarity()` / `containment()`（`memory-similarity.cjs`，中文 2-gram）；
 * 打分与类型权重用 `memory-explain.cjs` 那份（**唯一来源**，这里不留第二份）。
 * 只挑「经验类」类型：约束 / 要求 / 项目规则 / 流程 / 习惯 / 已定方案 ——
 * 偏好与事实不算「踩过的坑」，那是 Recall 的地盘。
 *
 * ── 失效与边界 ──
 *   · 只认**和本次提问有词重合**的（重合度为 0 的不算相关）——没有查询词就直接返回空串；
 *   · 一条组都没归并出来 → 返回空串（**不注入一个空标题**）；
 *   · 上限：3 组 / 400 字符（`MAX_CHARS`），超了宁可少说一组。
 *
 * ── 和「项目现状」（`project-facts.cjs`）不是一层 ──
 * 那边是**磁盘现状**（客观、可重算、无历史）；这边是**历史经验**（主观、不可重算、要积累）。
 * 两者正交，所以是两个文件、两段文字，只是搭同一趟车（`taskState` 层的新活第一轮分支）。
 */

const recall = require('./memory-recall.cjs')
const { similarity, containment } = require('./memory-similarity.cjs')
const { TYPE_LABEL } = require('./memory-explain.cjs')

/** 算「经验」的类型 —— 偏好 / 事实 / 临时不进这里 */
const REFLECT_TYPES = ['constraint', 'instruction', 'project_rule', 'workflow', 'habit', 'decision']
/**
 * 「在说同一件事」的门槛：取 `max(Jaccard, 包含度)` 与它比。
 *
 * 两个量都要看：同一件事常常被写成一条短的 + 一条补全的
 * （「改完 UI 要真跑一遍」/「改完 UI 要真跑一遍，还要把日志读出来比对」）——
 * 那时 Jaccard 低得看着不像同一件事，而包含度接近 1。
 *
 * 0.35 是**量出来的**，不是拍的（`tmp/reflect-thresholds.mjs`，2026-10-03）：
 *   · 同一件事、措辞不同 / 一句话补全 / 换了说法：0.435 / 1.000 / 0.500（最低 0.435）
 *   · 相关但不是同一件事（「改完 UI 要真跑」vs「改完 UI 记得截图」）：0.286 / 0.250（最高 0.286）
 *   · 无关：0.000
 * 可用的分割区间是 (0.286, 0.435)，取中间 0.35 —— 两边各留 ~20% 余量。
 * 要动这个数，先重跑那个量脚本，别拍脑袋。
 */
const SAME_THING_FLOOR = 0.35
/** 少于这个数的组不算「归并」（1 条的组就是 Recall，不重复说） */
const MIN_GROUP = 2
const MAX_GROUPS = 3
const MAX_CHARS = 400
/** 每组那句代表文字截多长 */
const MAX_SEED_CHARS = 60

/** 一行里不能有换行（会破坏清单结构） */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取一条记忆的人话编号（有 seq 用它，没有退回 id） */
function labelOf(item) {
  const seq = Number(item?.seq)
  return Number.isFinite(seq) && seq > 0 ? `#${seq}` : String(item?.id ?? '?')
}

/**
 * 把召回结果筛成「和这次要干的事相关的经验」。
 *
 * @param {Array<{ item: object, reasons: Array }>} entries `recall.retrieve({explain:true})` 的结果
 * @param {string} query 本轮用户说的话
 */
function candidates(entries, query) {
  if (!query) return []
  return (Array.isArray(entries) ? entries : []).filter(({ item, reasons }) => {
    if (!item || !REFLECT_TYPES.includes(item.type)) return false
    /* 相关性的判据用打分里的「关键词重合」那一项 —— 不另设一套门槛 */
    const overlap = (reasons ?? []).find((r) => r.key === 'overlap')
    return Number(overlap?.weight ?? 0) > 0
  })
}

/** 两条记忆是不是「在说同一件事」（门槛与理由见上面 SAME_THING_FLOOR） */
function isSameThing(a, b) {
  return Math.max(similarity(a, b), containment(a, b)) >= SAME_THING_FLOOR
}

/**
 * 贪心归并：按分数从高到低，和已有组的**代表**比相似度，够像就并进去。
 *
 * 刻意只跟代表比、不跟组里每一条比 —— 组一大会退化成 O(n²)，
 * 而这里要的只是「同一件事被记过几次」这个粗信号。
 *
 * @param {Array} list `candidates()` 的结果（已按分数降序）
 */
function cluster(list) {
  const groups = []
  for (const entry of list) {
    const text = oneLine(entry.item.content)
    const hit = groups.find((g) => isSameThing(g.seed, text))
    if (hit) hit.items.push(entry)
    else groups.push({ seed: text, items: [entry] })
  }
  return groups.filter((g) => g.items.length >= MIN_GROUP)
}

/**
 * 纯函数：把「已选好的召回结果」综合成一段。**不读磁盘、不写盘**（自检直接喂假数据）。
 *
 * @param {Array} entries 见 `candidates()`
 * @param {string} query
 * @returns {string} 没有成组的就返回空串
 */
function synthesize(entries, query = '') {
  const groups = cluster(candidates(entries, query))
  if (groups.length === 0) return ''
  const head = '## 这类活你以前踩过坑（同一件事记过不止一次）'
  const foot = '这些是**综合出来的经验**，不是本轮的要求；要看原文去「设置 → 记忆」，或按编号找。'
  const lines = []
  for (const group of groups.slice(0, MAX_GROUPS)) {
    const top = group.items[0].item
    const label = TYPE_LABEL[top.type] ?? '记忆'
    const text = oneLine(top.content)
    const shown = text.length > MAX_SEED_CHARS ? `${text.slice(0, MAX_SEED_CHARS)}…` : text
    const marks = group.items.map((entry) => labelOf(entry.item)).join('、')
    lines.push(`- 【${label}】${shown}（记过 ${group.items.length} 次：${marks}）`)
  }
  /* 超预算宁可少说一组 —— 不把最后那句说明截成半句 */
  const kept = []
  for (const line of lines) {
    const next = [head, ...kept, line, foot].join('\n')
    if (next.length > MAX_CHARS) break
    kept.push(line)
  }
  return kept.length === 0 ? '' : [head, ...kept, foot].join('\n').slice(0, MAX_CHARS)
}

/**
 * 真接口：自己去召回，再综合。
 *
 * @param {{ query?: string, projectId?: string }} [options]
 * @returns {string} 没有「记过不止一次」的经验 → 空串
 */
function reflect({ query = '', projectId = '' } = {}) {
  if (!query) return ''
  try {
    /* limit 要够大：归并看的是「同一件事被记过几次」，只取前 3 条会把组拆散 */
    const entries = recall.retrieve({ query, projectId, limit: 12, explain: true })
    return synthesize(entries, query)
  } catch {
    /* 记忆读不动不影响这一轮 —— 返回空串，不是抛出去把任务上下文弄没 */
    return ''
  }
}

module.exports = {
  reflect,
  synthesize,
  candidates,
  cluster,
  isSameThing,
  MAX_CHARS,
  REFLECT_TYPES,
  SAME_THING_FLOOR,
}
