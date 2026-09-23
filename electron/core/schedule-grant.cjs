/**
 * 定时任务：**授权上限**
 *
 * 这个文件是整个功能的第一等公民。理由很直接：定时任务等于给模型一把钥匙，
 * 而**用户不在场**。写不出调度器只是没功能，授权定宽了是「没人看着的破坏」。
 *
 * ── 设计底线 ──
 *
 * **没人在场 = 没人能批准。** 执行器给 loop 的 `confirm` 永远返回 false，
 * 所以任何需要用户点头的操作一律按拒绝处理，这里**不存在**「自动批准」路径。
 * 也就是说：能被调度跑掉的东西，必须是**不需要确认就能安全跑**的东西。
 *
 * ── 三档实际语义（读代码核过，不是照着愿望写的）──
 *
 * 关键在于项目现有的三道闸：
 *   · `tools.permission`：'readonly' 会硬拒所有写工具（含 run_shell）；
 *     'ask' 会对每个写工具问一次 —— 而我们的 confirm 恒为 false，
 *     所以 **'ask' 等于全拒**（run_shell 也在 WRITE_TOOLS 里，连 `git status`
 *     都跑不了）。'full' 才不提确认，交给下面两道闸。
 *   · `tools.fileScope`：'workspace' = 只能动工作目录内的文件，出去要授权
 *     （而授权要问人 → 被拒）；'full' = 不设限。
 *   · `tools.shellPolicy`：medium / high / critical 三档怎么办。
 *     low（只读形状的命令）由 `risk.decide` 硬编码放行，policy 管不着。
 *
 * 所以三档是：
 *
 *   readonly   permission=readonly  → 命令、写文件、MCP、生图、记忆 **全拒**；
 *                                    只剩读文件 / 列目录 / 搜索。
 *              ⚠️ **它连只读命令都跑不了**（`git status` 也不行）—— 这是
 *                 'readonly' 这道闸的实际行为，不是我们加的限制。所以界面上
 *                 那句话必须照实写，不能写成「能跑只读命令」。
 *
 *   workspace  permission=full + fileScope=workspace + {medium:allow, high:block,
 *              critical:block} → 工作目录内可读写；中低风险命令能跑；
 *              工作目录之外的文件一律被拒（capability 抛 PERMISSION_REQUIRED
 *              → 问人 → false → 拒）。
 *
 *   full       permission=full + fileScope=full + 同一套 shellPolicy →
 *              「全部工具」，**包括工作目录之外的文件**（这是它和 workspace
 *              唯一的实质差别）；高危 / 危急命令仍然一律被拒。
 *
 * ── 挡不住的东西（照实写，别粉饰）──
 *
 *   ① `search_web` 不在 WRITE_TOOLS 里，`tools.*` 里**没有**关它的开关 ——
 *      三档（连 readonly）都能联网搜索。想关只能靠运行时约束
 *      （loop 的 `threadSettings.allowNetwork`），那一层不归 configFor 管。
 *   ② 三档都拦不住「medium 这条命令本身有副作用」：`npm install`、`git push`
 *      都是 medium，在 workspace / full 档会**不问就执行**。这是策略选择
 *      （用户选了「可改工作目录」），但界面上那句 detail 不许写成「什么都不改」。
 *   ③ `high` 只有 `block` 一种可能：`risk.decide` 本身就不允许 high 静默放行
 *      （会强制降级成 ask），而 ask 在这里等于拒。
 */

const risk = require('./risk.cjs')

/** 三档，从最严到最松 */
const GRANTS = ['readonly', 'workspace', 'full']

/**
 * 给界面用的人话说明。
 *
 * ★ `detail` **必须**如实描述这一档实际能做什么 —— 界面拿它当选项副标题，
 *   写得比实际宽就是骗用户给权限，写得比实际严就是用户不敢用。
 */
const GRANT_INFO = {
  readonly: {
    label: '只读',
    detail:
      '只能看文件、列目录、搜索。任何命令（连只看不改的 git status 也不行）、写文件、联网工具之外的操作都会被拒',
  },
  workspace: {
    label: '可改工作目录',
    detail:
      '能在工作目录里读写文件、跑中低风险命令（装依赖、构建、提交都算中风险）。工作目录之外的文件、高风险命令和系统级改动一律被拒',
  },
  full: {
    label: '完整工具（仍然不批高危）',
    detail:
      '能用全部工具，连工作目录之外的文件也能读写。但高风险命令和系统级改动仍然会被拒 —— 没人在场，没人能批准',
  },
}

/** 每一档实际往配置里写的三个开关（改这里 = 改授权，动手前先想清楚） */
const PROFILES = {
  readonly: {
    permission: 'readonly',
    fileScope: 'workspace',
    /* 三档都不许放开 critical；high 也只能是 block（下面有断言锁住） */
    shellPolicy: { medium: 'block', high: 'block', critical: 'block' },
  },
  workspace: {
    permission: 'full',
    fileScope: 'workspace',
    shellPolicy: { medium: 'allow', high: 'block', critical: 'block' },
  },
  full: {
    permission: 'full',
    fileScope: 'full',
    shellPolicy: { medium: 'allow', high: 'block', critical: 'block' },
  },
}

/** 认不出来的档一律按最严的算（fail-closed） */
function tierOf(grant) {
  return GRANTS.includes(grant) ? grant : 'readonly'
}

/**
 * 按授权档算出一份**新的**配置。
 *
 * ★ 不许改传进来的那个对象：调用方通常直接给 `config.get()` 的缓存，
 *   改它等于把定时任务的临时授权写进了用户的全局配置 —— 定时任务跑一次，
 *   用户的设置就被悄悄放宽了。
 *
 * @param {string} grant
 * @param {object} baseConfig
 * @returns {object} 新对象（只有 tools 那三个字段是新的，其余共享）
 */
function configFor(grant, baseConfig) {
  const profile = PROFILES[tierOf(grant)]
  const base = baseConfig && typeof baseConfig === 'object' ? baseConfig : {}
  const tools = base.tools && typeof base.tools === 'object' ? base.tools : {}

  return {
    ...base,
    tools: {
      ...tools,
      permission: profile.permission,
      fileScope: profile.fileScope,
      /* 整个换掉，不是合并 —— 用户配置里的 high:'allow' 绝不许漏进来 */
      shellPolicy: { ...profile.shellPolicy },
    },
  }
}

/**
 * 被拒时给用户看的一句话。
 *
 * @param {string} grant
 * @param {{ tool?: string, command?: string }} context
 * @returns {string}
 */
function explainBlock(grant, context = {}) {
  const tier = tierOf(grant)
  const info = GRANT_INFO[tier]
  const tool = String(context.tool ?? '这个操作')
  const command = String(context.command ?? '').trim()
  const tail = command ? `：${command.slice(0, 200)}` : ''

  if (tier === 'readonly') {
    return `这条定时任务只有「${info.label}」权限，${tool} 被拒${tail} —— 只读档连只读命令也跑不了`
  }

  const verdict = command ? risk.classify(command) : null
  if (verdict && risk.rank(verdict.level) >= risk.rank('high')) {
    return `这条定时任务（${info.label}）不批这类命令（${risk.describe(verdict)}），${tool} 被拒${tail}`
  }

  return `这条定时任务的权限是「${info.label}」，${tool} 没被放行${tail} —— ${info.detail}`
}

module.exports = { GRANTS, GRANT_INFO, configFor, explainBlock }
