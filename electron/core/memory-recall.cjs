/**
 * 记忆：检索与注入
 *
 * 从 memory.cjs 拆出来的（那边过 300 行了）。
 *
 * 为什么必须做检索：
 * 记忆每轮都占上下文。攒到几百条之后，全塞进去既烧 token 又稀释注意力 ——
 * 更糟的是**无关的旧记忆会干扰当前任务**（「用户喜欢用 pnpm」出现在
 * 一个跟包管理无关的对话里，模型就可能开始自作主张）。
 *
 * 权重表和打分理由在 memory-explain.cjs —— **唯一来源**。
 * 这里不再留第二份：留了就会漂（改了一处，另一处还按老权重排序，
 * 而且没有任何测试会报错，因为分数从来没被断言过）。
 */

const store = require('./memory-store.cjs')
const { explain, scoreOf, summarize, WEIGHTS, TYPE_LABEL } = require('./memory-explain.cjs')

/**
 * 老名字继续导出（万一别处引用了 SCOPE_WEIGHT / TYPE_WEIGHT）——
 * 导出去的是 memory-explain 里那张表的引用，不是副本。
 */
const SCOPE_WEIGHT = WEIGHTS.scope
const TYPE_WEIGHT = WEIGHTS.type

/** 每轮注入的条数上限（配置里可调） */
function injectLimit() {
  try {
    return require('./config.cjs').get().memory.injectLimit
  } catch {
    return 12
  }
}

function retrieveEnabled() {
  try {
    return require('./config.cjs').get().memory.retrieve !== false
  } catch {
    return true
  }
}

/** 上一次注入的账（给界面解释「为什么是这几条」）。进程刚起时是 null */
let lastInjectionRecord = null

/**
 * 挑出与本次对话相关的记忆。
 *
 * 排序不依赖向量库（先不引那个复杂度），用的是**便宜且够用**的几个信号：
 *   范围（session/task 优先） + 类型权重 + 重要度 + 新鲜度 + 与提问的关键词重合
 * 权重与理由都在 memory-explain.cjs。
 *
 * `explain: true` 时返回 `[{ item, score, reasons }]`（解释用）；
 * 不传（或 false）时返回**和以前一模一样**的裸 item 数组 —— 现有调用方不能坏。
 *
 * @param {{ query?: string, projectId?: string, limit?: number, scope?: string, explain?: boolean }} options
 */
function retrieve({ query = '', projectId = '', limit, scope = '', explain: withReasons = false } = {}) {
  store.pruneExpired()

  let items = store.list({ status: 'active' })
  if (projectId) {
    /* 项目范围的记忆只在该项目里生效；别的项目看不到 */
    items = items.filter((i) => i.scope !== 'project' || i.projectId === projectId)
  } else {
    /* 单独对话没有项目上下文，不能意外带入某个项目的私有记忆 */
    items = items.filter((i) => i.scope !== 'project')
  }
  if (scope) items = items.filter((i) => i.scope === scope)

  const budget = limit ?? injectLimit()
  const now = Date.now()

  /*
   * 条数没到预算就不用打分：这时候「挑谁」不是问题，
   * 保持原来的顺序（最近更新在前）反而更稳。
   * explain 模式下也得走这条分支 —— 否则「有解释」和「没解释」两条路径
   * 会给出**不同的顺序**，解释就不可信了。
   */
  if (!retrieveEnabled() || items.length <= budget) {
    const picked = items.slice(0, budget)
    return withReasons ? picked.map((item) => ({ item, ...explain(item, { query, now }) })) : picked
  }

  const scored = items.map((item) =>
    withReasons
      ? { item, ...explain(item, { query, now }) }
      : { item, score: scoreOf(item, { query, now }) },
  )

  const ranked = scored.sort((a, b) => b.score - a.score).slice(0, budget)
  return withReasons ? ranked : ranked.map((entry) => entry.item)
}

/**
 * 生成要放进系统提示的那一段。
 *
 * 签名和返回值**都没变**（还是返回一段字符串，调用方在 loop-prompt.cjs）。
 * 顺手多记一份「这次为什么是这几条」的账，给界面用 —— 见 lastInjection()。
 *
 * @param {{ query?: string, projectId?: string }} [options]
 */
function buildPromptSection({ query = '', projectId = '' } = {}) {
  const budget = injectLimit()
  const picked = retrieve({ query, projectId, explain: true })
  const items = picked.map((entry) => entry.item)
  /* total 在 retrieve 之后再取：pruneExpired 该先跑完（顺序和以前一致） */
  const total = store.stats().active

  /*
   * 先记账再判空 —— 一条都没注入时也要有一本**完整的空账**。
   * 界面会读 lastInjection()，返 null / 缺字段会把它打崩。
   */
  lastInjectionRecord = {
    at: Date.now(),
    budget,
    total,
    injected: picked.map((entry) => ({
      id: entry.item.id,
      content: String(entry.item.content ?? '').slice(0, 60),
      type: entry.item.type,
      scope: entry.item.scope,
      score: entry.score,
      reason: summarize({ reasons: entry.reasons }),
    })),
  }

  if (items.length === 0) return ''

  const lines = items.map((item) => {
    const tag = TYPE_LABEL[item.type] ?? '记忆'
    const scope = item.scope === 'global' ? '' : `（${item.scope}）`
    return `- [${tag}${scope}] ${item.content}`
  })

  /*
   * 记一次「这条用过」。
   *
   * 这里以前调的是 `store.update(item.id, {})` —— 那个函数会把 updatedAt
   * 顶到现在，于是界面上的「最近更新」显示的其实是「最近被注入」，
   * 而且每轮都要重写一遍 memory.json。现在只动 lastUsedAt。
   */
  try {
    store.touch(items.map((item) => item.id))
  } catch {
    /* 记不上不影响这一轮注入 */
  }

  const more =
    total > items.length
      ? `\n（本轮最多注入 ${budget} 条，另外还有 ${total - items.length} 条没进来 —— 需要哪个就去设置 → 记忆里看看。）`
      : ''

  return `## 关于用户和这个项目（长期记忆）
${lines.join('\n')}${more}

这些是**你记得的事**，不是本轮的要求。与当前任务无关的就别硬套。`
}

/**
 * 上一次注入的账。
 *
 * 三条约定（界面依赖它们）：
 *   · 进程刚起、还没注入过 → null
 *   · 注入过但一条都没进来（比如刚清空记忆）→ **结构完整、injected 为空数组**，不是 null
 *   · 返回的是只读快照：改它不会影响内核里的那份
 */
function lastInjection() {
  if (!lastInjectionRecord) return null
  return {
    ...lastInjectionRecord,
    injected: lastInjectionRecord.injected.map((entry) => ({ ...entry })),
  }
}

module.exports = {
  retrieve,
  buildPromptSection,
  lastInjection,
  injectLimit,
  retrieveEnabled,
  TYPE_LABEL,
  SCOPE_WEIGHT,
  TYPE_WEIGHT,
}
