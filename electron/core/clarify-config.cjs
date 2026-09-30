/**
 * 开工前澄清的配置（AG-053）
 *
 * 为什么单独一个文件：`config-defaults.cjs` / `config-normalize.cjs` **都只剩
 * 一两行余量**（改这个功能之前分别是 299 / 298 行）。往里塞 8 行配置的结局是
 * 两个文件一起顶破硬约束 #2 —— 与其压那两个文件里的别人的注释，不如把「这一摊
 * 自己的配置」搬出来：那边各留一行 spread，数值与夹取规则在这里一处定义。
 *
 * ⚠️ 那两行 spread **特意不带注释** —— `config-defaults.cjs` 现在正好 300 行
 *    （红线上最后一行），加一行注释就红。要说明就写在这边。
 *
 * 四个值都是**可配置**的，不是为了好看：真机验证「离场 10 分钟自动采纳默认」时
 * 会把 `clarifyTimeoutMs` 临时调成几秒（等不了十分钟），自检则直接注入假时钟。
 *
 *   clarifyFirst      开工前是否先问清楚（默认开；关掉 = 回到今天的行为，也是回滚开关）
 *   clarifyIdleSeconds 多久没键鼠活动算「人不在」（秒）—— 在这以内**不计时**
 *   clarifyTimeoutMs  离场后等多久自动采纳默认选项（毫秒，默认 10 分钟）
 *   clarifyMaxWaitMs  同一任务累计离场等待上限（毫秒，默认 30 分钟），超了本任务不再弹卡
 *
 * ⚠️ 「在场不计时」是这套超时的关键：用户盯着屏幕想 20 分钟是在长出新需求，
 *    他走开 10 分钟才是「任务卡住了」。判据实现在 `clarify-timeout.cjs`。
 */

const DEFAULTS = {
  clarifyFirst: true,
  clarifyIdleSeconds: 30,
  clarifyTimeoutMs: 600000,
  clarifyMaxWaitMs: 1800000,
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 从助手配置里夹取这四个值（脏值一律回落到默认，不直接信磁盘）。
 *
 * @param {Record<string, unknown>} assistant 已经过 `config-normalize` 的助手那一块
 */
function normalize(assistant) {
  const source = assistant ?? {}
  return {
    clarifyFirst: source.clarifyFirst !== false,
    clarifyIdleSeconds: clamp(source.clarifyIdleSeconds, 5, 600, DEFAULTS.clarifyIdleSeconds),
    clarifyTimeoutMs: clamp(source.clarifyTimeoutMs, 1000, 3600000, DEFAULTS.clarifyTimeoutMs),
    clarifyMaxWaitMs: clamp(source.clarifyMaxWaitMs, 60000, 7200000, DEFAULTS.clarifyMaxWaitMs),
  }
}

module.exports = { DEFAULTS, normalize }
