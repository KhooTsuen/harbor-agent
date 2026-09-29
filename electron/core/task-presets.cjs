/**
 * 按任务类型的推荐参数（②-2）
 *
 * ── 要解决的问题 ──
 * 「改个错别字」和「重构一个模块」根本不是一个量级的活；创作要发散、
 * 代码要收敛 —— 用一个平均值去应付两端，两头都不合身。
 *
 * ── 三条设计决定 ──
 *
 * ① **判定复用意图路由的规则**（`mode-router.cjs`），不另写一套关键词。
 *    两处规则不一致时最难查（同一个词在两个地方判出不同结果）。
 *
 * ② **只在高置信时给建议**。「没命中规则」也会回退成 chat，但那是**兜底**不是判断。
 *
 * ③ **不再给预算**（2026-09-29 改）。以前这里会给每个任务预填「轮数 / 工具上限」
 *    （查资料 60/120、闲聊 15/30…），真机上用户看到的是「任务跑一半停住，
 *    提示说撞了轮数上限」——而那个数字**不是他设的**（任务记录里写着
 *    `budget: {maxSteps: 60, maxToolCalls: 120}`，来源就是这个文件）。
 *    用户要求「关于这一类的全部都要默认不设限」，所以现在只剩**温度**。
 *    预算改成只在任务卡片上「调整预算」里由用户自己填。
 *
 * ── 参数放在哪一层 ──
 *   · 温度 —— **对话级**（`threadSettings.temperature`）：这是这条对话的风格，
 *     改了要一直管用，但别去污染别的对话。
 *   · 预算 —— **任务级**（`task.budget`），而且只有用户自己填才有值。
 */

const modeRouter = require('./mode-router.cjs')

/** 每种任务类型的推荐值。`why` 是给用户看的**理由**，不是装饰 */
const TYPES = {
  chat: {
    label: '闲聊 / 问答',
    temperature: 0.7,
    why: '一两句就能答完的活，不需要多轮工具',
  },
  research: {
    label: '查资料',
    temperature: 0.3,
    why: '要忠于真的查到的内容（低温度少发挥）；反复搜索是常态',
  },
  code: {
    label: '写代码',
    temperature: 0.2,
    why: '代码要确定性 —— 同一个需求两次跑出两套写法是负担',
  },
  agent: {
    label: '多步执行',
    temperature: 0.3,
    why: '要读要改要跑，步骤多',
  },
  creative: {
    label: '创作',
    temperature: 0.9,
    why: '要发散 —— 温度低了写出来千篇一律',
  },
  think: {
    label: '分析 / 权衡',
    temperature: 0.4,
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

/** 这次真正用的温度：对话级 > 全局 > 内置默认。0 是合法温度，别用 `||` 兜底 */
function temperatureOf(threadSettings, config) {
  const raw = Number(threadSettings?.temperature)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 2) return raw
  const fallback = Number(config?.assistant?.temperature)
  return Number.isFinite(fallback) ? fallback : 0.7
}

module.exports = { TYPES, FALLBACK, detect, list, temperatureOf }

