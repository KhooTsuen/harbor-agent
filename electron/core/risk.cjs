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
 * @param {object} verdict classify() 的结果
 * @param {{ medium: string, high: string, critical: string }} policy
 */
function decide(verdict, policy) {
  const fallback = { low: 'allow', medium: 'ask', high: 'ask', critical: 'block' }
  const action =
    verdict.level === 'low' ? 'allow' : (policy?.[verdict.level] ?? fallback[verdict.level])

  /*
   * high / critical **没有「静默放行」这个选项**。
   *
   * critical 一直是这样（磁盘破坏、抓凭据，策略配 allow 也降级成 ask）。
   * high 是这次补上的：`tools/index.cjs` 里本来就有一条 `|| verdict.level === 'high'`
   * 在硬顶着，但 `decide()` 自己却返回 allow —— 于是设置页的风险试算会显示「允许」，
   * 和真正执行时不一样。「兜底写在调用方、自己反而不说」不该留，2026-09-23 挪进来。
   *
   * 这**不是**推翻用户的 `high: 'allow'`：那一档的语义是「别每次都弹同一个框」，
   * 不是「一次都不弹」。想完全不问，唯一正当的做法是自己去终端里跑。
   */
  if (rank(verdict.level) >= rank('high') && action === 'allow') {
    return {
      action: 'ask',
      forced: true,
      note: verdict.level === 'critical' ? '这类操作默认不静默放行' : '高风险操作至少确认一次',
    }
  }
  return { action }
}

/** 给用户看的一句话 */
function describe(verdict) {
  const label = { low: '低风险', medium: '中风险', high: '高风险', critical: '危险' }[verdict.level]
  const extra = verdict.reasons.length > 0 ? ` — ${verdict.reasons.join('；')}` : ''
  return `${label}${extra}`
}

module.exports = { LEVELS, classify, decide, describe, rank }
