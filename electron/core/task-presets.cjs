/**
 * 按任务类型的推荐参数（②-2）
 *
 * ── 要解决的问题 ──
 * 现在只有一套全局默认：温度 0.7、轮数上限 50、工具调用上限 100。
 * 可「改个错别字」和「重构一个模块」根本不是一个量级的活；创作要发散、
 * 代码要收敛 —— 用一个平均值去应付两端，两头都不合身。
 *
 * ── 三条设计决定 ──
 *
 * ① **判定复用意图路由的规则**（`mode-router.cjs`），不另写一套关键词。
 *    两处规则不一致时最难查（同一个词在两个地方判出不同结果）。
 *
 * ② **只在高置信时给建议**。「没命中规则」也会回退成 chat，但那是**兜底**不是判断 ——
 *    拿它去把 50 轮压成 15 轮，等于让用词朴素的人更容易撞上限。所以回退一律 `{}`，
 *    保持用户原来的全局设置。
 *
 * ③ **用户自己改过全局预算就不插手**（`budgetFor` 里的 `userTouchedBudget`）。
 *    预设是「更合身的默认值」，不是「我比用户懂」。他调过的数字一定是有原因的。
 *
 * ── 参数放在哪一层 ──
 *   · 温度 —— **对话级**（`threadSettings.temperature`）：这是这条对话的风格，
 *     改了要一直管用，但别去污染别的对话。
 *   · 预算 —— **任务级**（`task.budget`）：这是「这次的活最多跑多少」，
 *     本来就该跟着任务走；AG-040 的任务卡片上用户也能改。
 */

const modeRouter = require('./mode-router.cjs')
const budget = require('./budget.cjs')

/** 每种任务类型的推荐值。`why` 是给用户看的**理由**，不是装饰 */
const TYPES = {
  chat: {
    label: '闲聊 / 问答',
    temperature: 0.7,
    maxSteps: 15,
    maxToolCalls: 30,
    why: '一两句就能答完的活，不需要多轮工具',
  },
  research: {
    label: '查资料',
    temperature: 0.3,
    maxSteps: 60,
    maxToolCalls: 120,
    why: '要忠于真的查到的内容（低温度少发挥）；反复搜索是常态，轮数得放宽',
  },
  code: {
    label: '写代码',
    temperature: 0.2,
    maxSteps: 50,
    maxToolCalls: 100,
    why: '代码要确定性 —— 同一个需求两次跑出两套写法是负担',
  },
  agent: {
    label: '多步执行',
    temperature: 0.3,
    maxSteps: 60,
    maxToolCalls: 120,
    why: '要读要改要跑，步骤多，轮数与工具次数都得给够',
  },
  creative: {
    label: '创作',
    temperature: 0.9,
    maxSteps: 25,
    maxToolCalls: 50,
    why: '要发散 —— 温度低了写出来千篇一律',
  },
  think: {
    label: '分析 / 权衡',
    temperature: 0.4,
    maxSteps: 50,
    maxToolCalls: 100,
    why: '要讲清道理而不是罗列选项，但不必像代码那样死板',
  },
}

/** 兜底类型（命中不了任何规则时用）。**它的预算建议是空的** —— 见文件头 ② */
const FALLBACK = 'chat'

/**
 * 这句话像哪类任务。
 *
 * @param {string} text 用户说的话
 * @param {string} [forced] 用户手动指定的类型（`auto` / 空 = 自动）
 */
function detect(text = '', forced = '') {
  const hit = modeRouter.resolve(text, forced)
  const type = TYPES[hit.mode] ? hit.mode : FALLBACK
  return {
    type,
    label: TYPES[type].label,
    confidence: hit.confidence,
    reason: hit.reason,
    /* 自动兜底出来的结果不当判断用（见文件头 ②） */
    guessed: type === FALLBACK && hit.reason !== '用户手动指定',
  }
}

/** 给界面用：全部类型 + 推荐值 */
function list() {
  return Object.entries(TYPES).map(([type, item]) => ({ type, ...item }))
}

/** 用户是不是自己动过全局预算（动过就别插手） */
function userTouchedBudget(config) {
  const fromConfig = config?.agent?.budget ?? config?.budget ?? {}
  return Object.entries(budget.DEFAULTS).some(
    ([key, builtin]) => fromConfig[key] !== undefined && Number(fromConfig[key]) !== builtin,
  )
}

/**
 * 新建任务时该给什么预算。
 *
 * @param {string} goal 任务目标（就是用户那句话）
 * @param {object} [config] 主进程配置
 * @returns {{}} 或 `{ maxSteps, maxToolCalls }` —— 空对象 = 按用户自己的设置走
 */
function budgetFor(goal, config) {
  const hit = detect(goal)
  if (hit.guessed) return {}
  if (userTouchedBudget(config)) return {}
  const type = TYPES[hit.type]
  return { maxSteps: type.maxSteps, maxToolCalls: type.maxToolCalls }
}

/** 这次真正用的温度：对话级 > 全局 > 内置默认。0 是合法温度，别用 `||` 兜底 */
function temperatureOf(threadSettings, config) {
  const raw = Number(threadSettings?.temperature)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 2) return raw
  const fallback = Number(config?.assistant?.temperature)
  return Number.isFinite(fallback) ? fallback : 0.7
}

/**
 * 给界面用：这套预设相对**现在**的设置在改什么。
 *
 * @param {string} typeKey
 * @param {{ temperature?: number, maxSteps?: number, maxToolCalls?: number }} current
 */
function recommend(typeKey, current = {}) {
  const type = TYPES[typeKey]
  if (!type) return null
  const changes = []
  const push = (key, label, from, to) => {
    const now = Number(from)
    if (Number.isFinite(now) && now === to) return
    changes.push({ key, label, from: Number.isFinite(now) ? now : null, to })
  }
  push('temperature', '温度', current.temperature, type.temperature)
  push('maxSteps', '轮数上限', current.maxSteps, type.maxSteps)
  push('maxToolCalls', '工具调用上限', current.maxToolCalls, type.maxToolCalls)
  return {
    type: typeKey,
    label: type.label,
    why: type.why,
    values: {
      temperature: type.temperature,
      maxSteps: type.maxSteps,
      maxToolCalls: type.maxToolCalls,
    },
    changes,
  }
}

module.exports = { TYPES, FALLBACK, detect, list, budgetFor, temperatureOf, recommend }
