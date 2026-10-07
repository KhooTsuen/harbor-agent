/**
 * 风险分级那一关（run_shell）
 *
 * 从 `tools/index.cjs` 拆出来的 —— 那边加完「完全访问不再弹窗」那段说明就破 300 行了。
 * 这一块自成一体：**判断这条命令该跑、该问、还是该拒**，跑不跑由 index.cjs 决定。
 *
 * ── 两层的分工（2026-09-29 定下来）──
 *
 *   `shellPolicy`（设置 → 权限与安全）决定**这一类怎么办**：allow / ask / block
 *   `permission`（工具权限三档）决定**要不要打扰用户**：
 *     · 只读   → 不问；写操作在 index.cjs 那边直接拒
 *     · 需要确认 → 策略说 ask 就问（这一档的定义）
 *     · 完全访问 → **不问**。界面上写着「不给任何确认」，那就得真的不问
 *
 * 真机事故：用户选了「完全访问」，一条无害的 `node -e "require.resolve('globals')"`
 * 被判高风险 → 照样弹确认框，他点了拒绝（审计里留着 `approval=false`）。
 * 原因是两处都在硬顶：`risk.decide` 会把 allow 强制降级成 ask，`index.cjs` 还专门为
 * full 补过一句「即使是完全访问也问一次」。两处都改了：**默认值**负责保护
 * （开箱时 medium/high 问、critical 直接拒），**用户的选择**负责生效。
 */

const approvals = require('./approval.cjs')
const risk = require('../risk.cjs')
/* P0-3 步骤 4：权限结论收到 Action 上（`notePermission`，只记不改判断） */
const actionCore = require('../action.cjs')

/** 这一次要不要弹窗问用户 */
function shouldAsk(decided, permission) {
  return decided.action === 'ask' && permission === 'ask'
}

/**
 * @param {{ name: string, args: object, ctx: object, verdict: object, summary: string,
 *           startedAt: number, audit: (entry: object) => void, impact: string[] }} input
 * @returns {Promise<{ label: string, blocked?: string, asked?: boolean, approved?: boolean|null }>}
 *   `blocked` 非空 = 别执行（把这句话还给模型）；`asked` = 真的弹了窗；
 *   `approved` = 弹窗的结果（`null` = 没弹）
 */
async function gate({ name, args, ctx, verdict, summary, startedAt, audit, impact }) {
  const policy = ctx.shellPolicy ?? require('../config.cjs').get().tools.shellPolicy
  const decided = risk.decide(verdict, policy)
  const label = risk.describe(verdict)

  if (decided.action === 'block') {
    actionCore.notePermission(ctx, 'risk', 'blocked')
    audit({
      tool: name,
      args,
      startedAt,
      ok: false,
      error: `风险等级 ${verdict.level} 被阻止`,
      extras: { risk: verdict },
    })
    return {
      label,
      blocked:
        `错误：这条命令被拦下了（${label}）。\n` +
        '这是保护措施，不是故障。如果确实要跑，请在终端面板里自己执行。',
    }
  }

  if (!shouldAsk(decided, ctx.permission)) {
    actionCore.notePermission(ctx, 'risk', 'allowed')
    /* 不问就放行（完全访问 / 低风险）→ 留痕：审计里记下它是哪个风险等级进来的 */
    if (risk.rank(verdict.level) >= risk.rank('medium')) {
      audit({
        tool: name,
        args,
        startedAt,
        ok: true,
        approval: null,
        error: '',
        extras: { risk: verdict, riskSkipped: `permission=${ctx.permission ?? ''}` },
      })
    }
    return { label, approved: null }
  }

  if (typeof ctx.confirm !== 'function') {
    actionCore.notePermission(ctx, 'risk', 'blocked')
    audit({
      tool: name,
      args,
      startedAt,
      ok: false,
      error: '没有可用的确认界面，按拒绝处理',
      extras: { risk: verdict },
    })
    return {
      label,
      blocked: `错误：这条命令需要用户确认（${label}），但当前没有可确认的界面，按拒绝处理。`,
    }
  }

  const approved = await approvals.ask(ctx, {
    kind: 'risk',
    name,
    args,
    risk: verdict,
    summary: `${summary}\n\n风险：${label}`,
    impact,
  })
  if (approved !== true) {
    actionCore.notePermission(ctx, 'risk', 'denied')
    audit({
      tool: name,
      args,
      startedAt,
      approval: false,
      ok: false,
      error: '用户拒绝高风险命令',
      extras: { risk: verdict },
    })
    return { label, asked: true, approved: false }
  }
  actionCore.notePermission(ctx, 'risk', 'asked')
  return { label, asked: true, approved: true }
}

module.exports = { gate, shouldAsk }
