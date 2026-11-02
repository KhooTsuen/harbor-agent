/**
 * `run_shell` 的两个「关卡」：网络策略 + 执行目录边界
 *
 * 从 `run_shell.cjs` 搬出来的（2026-11-02）。搬的理由是行数：那边给失败事实加
 * 「退出码 + 超时 + 中断」三个字段后贴到 300 行红线，需要腾出位置。拆的边界是
 * **关卡 vs 执行** —— 这两个函数都在「命令真正跑起来」之前决定「能不能跑」，
 * 而 `run_shell.cjs` 剩下的部分是「怎么跑、跑完怎么回报」。
 *
 * ★ `DANGEROUS` 那张「任何情况下都不该做」的命令清单**没搬**：它是最后一道闸，
 *   留在 `run_shell.cjs` 里比藏在另一个文件里更容易被看到。
 *
 * ⚠️ `networkGuard` 被自检直接调用（`scripts/selftest/groups/73-net-policy.mjs`
 *   走 `require('.../run_shell.cjs').networkGuard`），所以 `run_shell.cjs` 仍然
 *   把它挂在 `module.exports` 上 —— 搬的是实现，不是对外契约。
 */

const netPolicy = require('../net-policy.cjs')
const risk = require('../risk.cjs')
const { resolvePath, decideNetAsk } = require('./_shared.cjs')

/**
 * 网络策略这一关：**只会把 allow 变严，永远不会把 ask 变松**。
 *
 * 为什么不在这里弹确认：确认界面不在这个文件（在 `tools/index.cjs` 的 approval 流程），
 * 这里弹不出来。所以 `ask` 只有两种安全落地 —— 见 `_shared.decideNetAsk`：
 *   · 上层这一档会问（risk.decide → 'ask'）→ 交给它，用户照样看到确认框
 *   · 上层这一档不问（完全访问档 / 静默放行）→ **这里拦掉**，
 *     否则就成了「网络策略说每次先问，结果没人被问就把请求发出去了」
 *
 * @returns {string} 空串 = 放行；非空 = 给用户看的拒绝理由
 */
function networkGuard(command, ctx) {
  const decided = netPolicy.decide({ kind: 'shell', target: command, ctx })
  if (decided.action === 'allow') return ''
  if (decided.action === 'deny') {
    return `这条命令要联网，被网络策略拦下了。\n原因：${decided.reason}\n命令：${command}`
  }

  /* 只剩「先问」这一档：上层到底会不会问 */
  let upperAsk = false
  let upperNote = ''
  try {
    const verdict = risk.classify(command)
    const policy = ctx.shellPolicy ?? require('../config.cjs').get().tools.shellPolicy
    const decidedUpper = risk.decide(verdict, policy)
    upperAsk = risk.rank(verdict.level) >= risk.rank('medium') && decidedUpper.action === 'ask'
    upperNote = `上层风险分级这一档（${verdict.level}）不会问你（${decidedUpper.action}）`
  } catch (error) {
    upperNote = `读不到上层的风险策略（${error instanceof Error ? error.message : error}）`
  }
  if (decideNetAsk(decided, upperAsk).pass) return ''

  return (
    `这条命令要联网，网络策略要求「每次先问」，但这一层没有确认界面，${upperNote} ——\n` +
    '为了不出现「没人被问就把请求发出去」，按拒绝处理。\n' +
    `原因：${decided.reason}\n命令：${command}`
  )
}

/**
 * 执行目录也要过权限边界（审计问题 17）。
 *
 * 文件工具（`read_file` / `write_file`…）都走 `resolvePath`，所以越过工作目录会被
 * 拦下来问用户；但 shell 这条路以前是**裸的** —— `run_shell({ command: 'type C:\\Users\\x\\.ssh\\id_rsa' })`
 * 或直接 `cd /d C:\\` 就绕开了整套边界。这里把 cwd 交给同一个 `resolvePath`：
 *   · 在工作目录内 → 正常放行
 *   · 在外面但拿过授权 → 放行（授权表就在那边）
 *   · 没授权 → 抛 PermissionRequiredError，由 `tools/index.cjs` 转成向用户要授权
 *
 * 没传 cwd 时退到 `ctx.workdir`（和以前一样）—— 没有工作目录可用时只好不管，
 * 交给上层反正会拦（这是现有行为，不在这里改）。
 */
function resolveShellCwd(rawCwd, ctx) {
  const asked = rawCwd === undefined || rawCwd === null || rawCwd === ''
  const wanted = String(asked ? (ctx.workdir ?? '') : rawCwd)
  if (!wanted) return ctx.workdir ?? ''
  return resolvePath(wanted, ctx.workdir ?? '', ctx)
}

module.exports = { networkGuard, resolveShellCwd }
