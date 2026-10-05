/**
 * 规模确认的配置（A2）
 *
 * 为什么单独一个文件：`config-defaults.cjs` / `config-normalize.cjs` **都正好 300 行**
 * （红线上最后一行），往里塞 4 个值就要破硬约束 #2。和 `clarify-config.cjs` 同一个理由、
 * 同一个做法：那边各留一行 spread，数值与夹取规则在这里一处定义。
 * ⚠️ 那两行 spread **特意不带注释** —— 这次是**压掉了别人两处注释**才腾出的行
 *   （`config-defaults` 的 maxTokens 说明、`config-normalize` 的 responseDepth 折行）。
 *   要给这两个值写说明，写在这里。
 *
 * ── 四个值 ──
 *   scaleFirst        重操作动手前要不要先问规模（默认开）
 *                     ★ **它只关「规模」这一层，不动危险度** —— 关掉之后
 *                       `risk.cjs` / `risk-gate.cjs` / 权限层一个字没变：
 *                       危险命令该拦照拦、该问照问，敏感文件该提示照提示。
 *                       它是这层的回滚开关，**不是**「关掉安全检查」。
 *   scaleHardSeconds  预估耗时 ≥ 它 → 硬拦（先问规模再说）
 *   scaleWarnSeconds  预估耗时 ≥ 它 → 记一条 note（不拦；提示词要求模型口头说一句）
 *   scaleMaxFiles     递归 / 批量时估出来的条目数 ≥ 它就硬拦（估算是**下界**，见 scale-files.cjs）
 *
 * ── 校准（不靠拍，靠数据）──
 * 每次触发都在审计里留了 `extras.scale`（含预估秒数 / 文件数 / 命中的信号 / 判决）
 * 外加一行 `[规模预检]` 日志。**跑一段时间后从 `data/audit/*.jsonl` 统计
 * 「预估 ≥ 300s 的操作实际触发了多少次、实际跑了多久」**，用来校准 `scaleHardSeconds`
 * 的默认值 —— 默认值现在是拍的（120 秒），以后不该继续拍。
 */

const DEFAULTS = {
  scaleFirst: true,
  scaleHardSeconds: 120,
  scaleWarnSeconds: 30,
  scaleMaxFiles: 2000,
}

/** 配置项的键（自检「每个配置项都必须有人读」用它逐个查） */
const KEYS = Object.keys(DEFAULTS)

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
    scaleFirst: source.scaleFirst !== false,
    scaleHardSeconds: clamp(source.scaleHardSeconds, 10, 1800, DEFAULTS.scaleHardSeconds),
    scaleWarnSeconds: clamp(source.scaleWarnSeconds, 0, 600, DEFAULTS.scaleWarnSeconds),
    scaleMaxFiles: clamp(source.scaleMaxFiles, 100, 1000000, DEFAULTS.scaleMaxFiles),
  }
}

module.exports = { DEFAULTS, KEYS, normalize }
