/**
 * 记忆：检索与注入
 *
 * 从 memory.cjs 拆出来的（那边过 300 行了）。
 *
 * 为什么必须做检索：
 * 记忆每轮都占上下文。攒到几百条之后，全塞进去既烧 token 又稀释注意力 ——
 * 更糟的是**无关的旧记忆会干扰当前任务**（「用户喜欢用 pnpm」出现在
 * 一个跟包管理无关的对话里，模型就可能开始自作主张）。
 */

const store = require('./memory-store.cjs')
const { similarity } = require('./memory-similarity.cjs')

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

/** 范围权重：越具体越优先 */
const SCOPE_WEIGHT = { session: 5, task: 4, project: 3, workspace: 2, global: 1 }

/** 类型权重：规则/约束比「事实」更该被遵守 */
const TYPE_WEIGHT = {
  constraint: 4,
  instruction: 3.5,
  project_rule: 3,
  preference: 2.5,
  decision: 2.2,
  workflow: 1.8,
  habit: 1.6,
  fact: 1,
  temporary: 0.4,
}

const TYPE_LABEL = {
  preference: '偏好',
  fact: '事实',
  workflow: '流程',
  project_rule: '项目规则',
  constraint: '约束',
  decision: '已定方案',
  temporary: '临时',
  habit: '习惯',
  instruction: '要求',
}

/**
 * 挑出与本次对话相关的记忆。
 *
 * 排序不依赖向量库（先不引那个复杂度），用的是**便宜且够用**的几个信号：
 *   范围（session/task 优先） + 类型权重 + 重要度 + 新鲜度 + 与提问的关键词重合
 *
 * @param {{ query?: string, projectId?: string, limit?: number, scope?: string }} options
 */
function retrieve({ query = '', projectId = '', limit, scope = '' } = {}) {
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
  if (!retrieveEnabled() || items.length <= budget) {
    return items.slice(0, budget)
  }

  const now = Date.now()
  const scored = items.map((item) => {
    const overlap = query ? similarity(item.content, query) : 0.5
    const ageDays = (now - item.createdAt) / (24 * 60 * 60 * 1000)
    const freshness = 1 / (1 + ageDays / 30)

    const score =
      (SCOPE_WEIGHT[item.scope] ?? 1) +
      (TYPE_WEIGHT[item.type] ?? 1) +
      item.importance * 2 +
      (item.confidence ?? 1) * 1.5 +
      freshness +
      overlap * 6

    return { item, score }
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, budget)
    .map((entry) => entry.item)
}

/**
 * 生成要放进系统提示的那一段。
 *
 * @param {{ query?: string, projectId?: string }} [options]
 */
function buildPromptSection({ query = '', projectId = '' } = {}) {
  const items = retrieve({ query, projectId })
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

  const total = store.stats().active
  const more =
    total > items.length
      ? `\n（另外还有 ${total - items.length} 条记忆与本次不太相关，需要时可以让用户去看设置 → 记忆。）`
      : ''

  return `## 关于用户和这个项目（长期记忆）
${lines.join('\n')}${more}

这些是**你记得的事**，不是本轮的要求。与当前任务无关的就别硬套。`
}

module.exports = { retrieve, buildPromptSection, injectLimit, retrieveEnabled, TYPE_LABEL }
