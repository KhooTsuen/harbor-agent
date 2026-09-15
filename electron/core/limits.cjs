/**
 * 用量闸（预算）
 *
 * 之前只有「用量统计」——**能看，但拦不住**。用一个贵模型跑一晚上，
 * 第二天看统计才知道花了多少。这个模块负责在**每次调模型之前**查一次账。
 *
 * ⚠️ 为什么按 **token 数** 而不是金额：
 * 金额要维护一张「每个模型多少钱」的价目表 —— 那个表会过期，
 * 而且用户走中转站时的实际计价常常和官方不同（OpenRouter 各后端价格都不一样）。
 * token 数是上游直接给的、我们本来就记着的，**准而不用维护**。
 * 真要换算成钱，那是 UsageTab 的事，不该让闸门依赖它。
 *
 * 记账来源是 stats.cjs（按天分桶），所以「今天用了多少」不需要额外存状态。
 */

const stats = require('./stats.cjs')
const log = require('./log.cjs')

/** 默认值（config-normalize 也引用这份） */
const DEFAULTS = {
  enabled: false,
  /** 0 = 不限 */
  dailyTokens: 0,
  monthlyTokens: 0,
  /** block = 直接拦住；warn = 只提示，继续跑 */
  onExceed: 'block',
}

function limitsFromConfig() {
  try {
    return { ...DEFAULTS, ...(require('./config.cjs').get().limits ?? {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

/*
 * 日期口径**直接复用 stats 的**，不自己实现。
 *
 * 踩过：我在这个文件里又写了一份日期函数，用的是本地日期，
 * 而 stats 当时用的是 UTC —— 两边悄悄错开，于是「今天用了多少」
 * 永远算成 0，闸门等于没有。测试里用「统计的键和闸门的键必须相等」
 * 这条断言把它抓出来了。
 */
const dayKey = stats.today

function monthKey(now = new Date()) {
  return dayKey(now).slice(0, 7)
}

/**
 * 从统计里算出今 / 本月的用量。
 *
 * @returns {{ today: number, month: number, days: number }}
 */
function usage(now = new Date()) {
  const data = stats.load()
  const today = dayKey(now)
  const month = monthKey(now)

  let todayTokens = 0
  let monthTokens = 0
  let days = 0

  for (const [day, bucket] of Object.entries(data.byDay ?? {})) {
    const total = Number(bucket?.total) || 0
    if (day === today) todayTokens = total
    if (day.startsWith(month)) {
      monthTokens += total
      days += 1
    }
  }

  return { today: todayTokens, month: monthTokens, days }
}

/**
 * 查一次账。
 *
 * @param {{ now?: Date }} [options]
 * @returns {{ limited: boolean, exceeded: boolean, level: 'day' | 'month' | null,
 *             used: number, limit: number, onExceed: string,
 *             today: number, month: number, message: string }}
 */
function check({ now = new Date() } = {}) {
  const limits = limitsFromConfig()
  const used = usage(now)

  const base = {
    limited: false,
    exceeded: false,
    level: null,
    used: 0,
    limit: 0,
    onExceed: limits.onExceed,
    today: used.today,
    month: used.month,
    message: '',
  }

  if (limits.enabled !== true) return base

  /* 先看日限，再看月限 —— 哪个先超就报哪个，理由更直接 */
  const dayOver = limits.dailyTokens > 0 && used.today >= limits.dailyTokens
  const monthOver = limits.monthlyTokens > 0 && used.month >= limits.monthlyTokens

  if (!dayOver && !monthOver) {
    return { ...base, limited: true, limit: limits.dailyTokens || limits.monthlyTokens }
  }

  const level = dayOver ? 'day' : 'month'
  const usedValue = dayOver ? used.today : used.month
  const limitValue = dayOver ? limits.dailyTokens : limits.monthlyTokens
  const scope = dayOver ? '今天' : '本月'

  return {
    ...base,
    limited: true,
    exceeded: true,
    level,
    used: usedValue,
    limit: limitValue,
    message:
      `${scope}的用量已经到上限了（${usedValue.toLocaleString()} / ${limitValue.toLocaleString()} token）。` +
      '这是你在「设置 → 用量」里设的闸门，不是故障。要接着用就去把上限调高或关掉它。',
  }
}

/**
 * 闸门的判定结果 + 记一笔日志。
 *
 * @returns {{ blocked: boolean, message: string, info: object }}
 */
function guard(options) {
  const info = check(options)
  if (info.exceeded) {
    log.warn(`用量闸拦下：${info.message}`)
  }
  return { blocked: info.exceeded && info.onExceed === 'block', message: info.message, info }
}

/**
 * 在 agent 循环里调：超了推个事件，block 模式下直接抛。
 *
 * 放在这里而不是 loop.cjs：loop 只该看到「查一次账」这一句，
 * 至于超没超、要不要拦、报什么话，都是预算自己的事。
 */
function enforce(emit) {
  const gate = guard()
  if (!gate.info.exceeded) return
  emit?.({ type: 'budget', ...gate.info, blocked: gate.blocked })
  if (gate.blocked) throw new Error(gate.message)
}

module.exports = { DEFAULTS, check, guard, enforce, usage, dayKey, monthKey }
