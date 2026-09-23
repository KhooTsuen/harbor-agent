/**
 * 定时任务：时间计算
 *
 * **纯函数** —— 不碰 fs、不 require 主进程模块，所以自检能直接跑它
 * （改 electron/ 必须跑内核自检，而自检跑不起 Electron 进程）。
 *
 * 为什么单独一个文件：定时任务这件事里有四块，**风险完全不同** ——
 *   · 什么时候该跑           ← 这个文件（不用反复审）
 *   · 能干什么（授权上限）   ← schedule-grant.cjs（要反复审的那块）
 *   · 落盘                   ← schedule-store.cjs
 *   · 执行 + 心跳            ← schedule-run.cjs
 * 挤在一个文件里必然破 300 行红线，而且会把要审的东西埋进不用审的东西里。
 *
 * `when` 只有两种形状：
 *   { type: 'interval', minutes: 30 }   每 N 分钟（N 最小 5，见 validateWhen）
 *   { type: 'daily', at: '09:30' }      每天某个钟点 —— **本地时间**，不是 UTC
 */

/** 最小间隔：比 5 分钟更密的定时任务没有正当用途，只会把模型配额烧光 */
const MIN_INTERVAL_MINUTES = 5

/**
 * 防抖窗口：刚跑过的不算到期。
 *
 * 心跳是 30 秒一次，而下一次该跑的时刻是「上次跑的时刻 + 间隔」推出来的。
 * 没有这个窗口，一条 2 秒前刚跑完的任务会立刻被判成又到期了 —— 连着跑，
 * 每次都是一个完整的 agent 循环（要花 token）。
 */
const DEBOUNCE_MS = 60 * 1000

/** HH:MM（24 小时制，本地时间） */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 取分钟数：只要求「正数且有限」。
 *
 * ★ 这里**故意不管**「最小 5 分钟」那条 —— 那是**策略**，归 validateWhen 管。
 *   nextRunAt 只负责算时间：给它一个 1 分钟的间隔，它就该老实算出 1 分钟后的
 *   时刻（isDue 的防抖用例就靠这个）。把策略塞进计算函数里，会让
 *   「校验通不过的值算不出时间」和「算不出时间的值一律非法」变成同一件事。
 */
function minutesOf(value) {
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 把 when 解析成内部形状；不认识就 null（调用方一律 fail-closed 处理） */
function parseWhen(when) {
  if (!when || typeof when !== 'object') return null
  if (when.type === 'interval') {
    const minutes = minutesOf(when.minutes)
    return minutes > 0 ? { kind: 'interval', minutes } : null
  }
  if (when.type === 'daily') {
    const match = HHMM.exec(String(when.at ?? ''))
    if (!match) return null
    return { kind: 'daily', hours: Number(match[1]), minutes: Number(match[2]) }
  }
  return null
}

/**
 * 校验用户填的时间。错误消息是**给人看的**一句话。
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function validateWhen(when) {
  if (!when || typeof when !== 'object') {
    return { ok: false, error: '时间设置无效：要选「每 N 分钟」或「每天某个钟点」' }
  }
  if (when.type === 'interval') {
    const minutes = Number(when.minutes)
    if (!Number.isFinite(minutes)) return { ok: false, error: '间隔要填一个数字（分钟）' }
    if (minutes < MIN_INTERVAL_MINUTES) {
      return { ok: false, error: `间隔不能小于 ${MIN_INTERVAL_MINUTES} 分钟` }
    }
    return { ok: true }
  }
  if (when.type === 'daily') {
    if (!HHMM.test(String(when.at ?? ''))) {
      return { ok: false, error: '时间要写成 HH:MM（24 小时制），比如 09:30' }
    }
    return { ok: true }
  }
  return { ok: false, error: '时间类型只能是 interval（每 N 分钟）或 daily（每天某时刻）' }
}

/** 给用户看的中文短句 */
function describeWhen(when) {
  const spec = parseWhen(when)
  if (!spec) return '时间设置无效'
  if (spec.kind === 'interval') return `每 ${spec.minutes} 分钟`
  return `每天 ${pad2(spec.hours)}:${pad2(spec.minutes)}`
}

/**
 * 下一次该跑的时刻（毫秒时间戳）；算不出来返回 0。
 *
 * @param {object} when
 * @param {number} [from] 从哪一刻往后推（缺省 = 现在）
 * @returns {number}
 */
function nextRunAt(when, from = Date.now()) {
  const base = Number(from)
  if (!Number.isFinite(base)) return 0

  const spec = parseWhen(when)
  if (!spec) return 0

  if (spec.kind === 'interval') {
    const next = base + spec.minutes * 60_000
    return Number.isFinite(next) ? Math.floor(next) : 0
  }

  /* 本地时间的「今天这个点」。用 setHours 而不是自己拼 UTC —— 用户填的是墙上那个钟 */
  const date = new Date(base)
  date.setHours(spec.hours, spec.minutes, 0, 0)
  /* 「今天这个点」已经过去（或正好是此刻）→ 明天这个点。
     相等也算过去：不然刚跑完的那一刻会被算出「下一次 = 现在」。 */
  if (date.getTime() <= base) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/**
 * 这一刻该不该跑。
 *
 * @param {{ enabled?: boolean, when?: object, lastRunAt?: number, createdAt?: number }} item
 * @param {number} [now]
 * @returns {boolean}
 */
function isDue(item, now = Date.now()) {
  if (!item || typeof item !== 'object') return false
  /* 没开的不跑。用严格判断：字段缺失也算没开（fail-closed） */
  if (item.enabled !== true) return false

  const current = Number(now)
  if (!Number.isFinite(current)) return false

  const last = Number(item.lastRunAt) || 0
  /* 防抖：刚跑过的不算到期（心跳抖动不该让同一条连跑） */
  if (last > 0 && current - last < DEBOUNCE_MS) return false

  /*
   * ★ 基准必须是「上次跑的时刻」（没跑过就是「创建时刻」），**不能是 now**。
   *   用 now 当基准永远算出一个未来的时刻 → 永远不到期 → 定时任务一次都不跑。
   */
  const base = last > 0 ? last : Number(item.createdAt) || current
  const next = nextRunAt(item.when, base)
  return next > 0 && next <= current
}

module.exports = {
  MIN_INTERVAL_MINUTES,
  DEBOUNCE_MS,
  validateWhen,
  describeWhen,
  nextRunAt,
  isDue,
}
