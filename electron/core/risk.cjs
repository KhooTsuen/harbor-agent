/**
 * Shell 风险分级
 *
 * **这不是沙箱，这是「把话说明白」的那一层。**
 *
 * 原来只有一张危险命令黑名单（11 条正则），拦不住的太多了：
 * PowerShell / python / node / .bat / .ps1 / .vbs、下载后执行、
 * base64 解码执行、间接调系统工具、环境变量窃取、命令替换、管道……
 * 靠穷举命令名永远补不完。
 *
 * 所以换个思路：**不判断「这条命令危不危险」，判断「它属于哪一类行为」**，
 * 再按类别给策略。分类是启发式的（也会漏），但每一类都有明确的人工确认点，
 * 而且**理由会显示给用户**——用户看到的不是「被拦了」，而是
 * 「这条命令会改注册表」。
 *
 * 四个等级：
 *   low      只读查询（pwd / ls / git status）
 *   medium   构建、装依赖、改文件、网络取数据
 *   high     递归删除、改系统配置、提权、下载后执行、强推、**内联脚本**
 *   critical 格式化磁盘、破坏系统、抓凭据、关杀软、**改账户** —— **默认直接拦**
 *
 * 模式表在 `risk-patterns.cjs`：那张表还要继续长，和逻辑放一起会顶到行数红线。
 */

const {
  CRITICAL,
  HIGH,
  MEDIUM,
  OPAQUE,
  NETWORK,
  WRITES,
  isReadOnlyCommand,
} = require('./risk-patterns.cjs')

/** 从低到高 */
const LEVELS = ['low', 'medium', 'high', 'critical']

const rank = (level) => LEVELS.indexOf(level)

/**
 * 给一条命令定级。
 *
 * @param {string} command
 * @returns {{ level: 'low'|'medium'|'high'|'critical', reasons: string[], network: boolean, writes: boolean, installs: boolean, elevation: boolean, opaque: string[] }}
 */
function classify(command) {
  const text = String(command ?? '').trim()
  const reasons = []
  const opaque = []
  let level = 'low'

  const bump = (next) => {
    if (rank(next) > rank(level)) level = next
  }

  /* critical 优先 —— 命中就是命中 */
  for (const [pattern, label] of CRITICAL) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('critical')
    }
  }

  for (const [pattern, label] of HIGH) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('high')
    }
  }

  for (const [pattern, label] of MEDIUM) {
    if (pattern.test(text)) {
      reasons.push(label)
      bump('medium')
    }
  }

  for (const [pattern, label] of OPAQUE) {
    if (pattern.test(text)) opaque.push(label)
  }
  /* 拼接/嵌套/命令替换：即使单看每条都是只读，整体也按中风险处理 */
  if (opaque.length > 0) {
    reasons.push(...opaque)
    bump('medium')
  }

  /*
   * 一条都不命中：可能是没见过的只读命令，也可能是没见过的写命令。
   * `isReadOnlyCommand` 要求**整条**都像只读（不只看开头）—— 见那边的注释，
   * `find . -delete` 就是「只审开头」漏掉的。
   */
  if (reasons.length === 0 && !isReadOnlyCommand(text)) {
    reasons.push('没有匹配到已知的只读命令')
    bump('medium')
  }

  const network = NETWORK.test(text)
  const writes = WRITES.test(text)
  const installs =
    /\b(npm|pnpm|yarn)\s+(install|i|ci|add)\b|\bpip\s+install\b|\b(cargo|go)\s+(install|get)\b|\b(choco|winget|scoop)\s+install\b/i.test(
      text,
    )
  const elevation = /\b(runas|sudo)\b|\b-verb\s+runas\b|\bstart-process\b[^\n]*-verb\s+runas/i.test(
    text,
  )

  return {
    level,
    reasons: [...new Set(reasons)].slice(0, 5),
    network,
    writes,
    installs,
    elevation,
    opaque,
    command: text.slice(0, 400),
  }
}

/**
 * 按配置策略裁决：'allow' | 'ask' | 'block'
 *
 * **只看策略写了什么，不再偷偷推翻用户的选择。**
 *
 * 2026-09-29 改：以前 high / critical 即使被配成 `allow` 也会被强制降级成 `ask`。
 * 真机后果（用户报的）：他选了「完全访问」（界面上写着「不给任何确认，直接改、直接跑」），
 * 一条**无害的** `node -e "require.resolve('globals')"` 被判高风险 → 照样弹确认框，
 * 他点了拒绝。审计里留着那一条（`approval=false`）。
 * 「设置里写了 allow、执行时还是问」正是本项目最忌讳的**声明了但不生效**。
 *
 * 现在保护来自**默认值**，不来自偷偷改判：默认 medium/high = ask、critical = block
 * （`config-defaults.cjs`），也就是说开箱状态下会毁数据的命令**连问都不问、直接拒**。
 * 想更严/更松都去改策略 —— 改了就是改了。
 *
 * @param {object} verdict classify() 的结果
 * @param {{ medium: string, high: string, critical: string }} policy
 */
function decide(verdict, policy) {
  const fallback = { low: 'allow', medium: 'ask', high: 'ask', critical: 'block' }
  const action =
    verdict.level === 'low' ? 'allow' : (policy?.[verdict.level] ?? fallback[verdict.level])
  return { action }
}

/** 给用户看的一句话 */
function describe(verdict) {
  const label = { low: '低风险', medium: '中风险', high: '高风险', critical: '危险' }[verdict.level]
  const extra = verdict.reasons.length > 0 ? ` — ${verdict.reasons.join('；')}` : ''
  return `${label}${extra}`
}

module.exports = { LEVELS, classify, decide, describe, rank }
