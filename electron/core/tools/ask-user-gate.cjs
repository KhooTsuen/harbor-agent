/**
 * 执行前的计划复核（A 案，2026-10-07）—— `ask_user` 的 `gate: true` 那条路
 *
 * 从 `ask_user.cjs` 拆出来的（那边加完这一路顶到 318 行，硬约束 #2 = 300）。
 *
 * 用户说「先分析不要动、我确认再执行」时用的闸门。与澄清共用 `confirm-bridge`
 * 那条往返（`ctx.clarify` → `handlers/chat-confirm.cjs` → `core/confirm-bridge.cjs`），
 * **不需要新 IPC 通道、也不需要新卡片类型**（渲染层那张澄清卡照用）。
 *
 * 为什么需要它：审批粒度是「每次工具调用」，而「写一个脚本 + 跑一条命令」只批一次 ——
 * 用户报的正是「说了先分析，结果 92 次移动只批了一回」。这条把「等明确同意」变成
 * **执行前的一次往返**。
 *
 * ★ 与澄清的三点不同，方向都是「保守」：
 *   ① 只有明确点「就按这个计划执行」才放行 —— 自由回答 / 跳过 / 离场一律算「没批准」
 *      （澄清那边离场是采纳默认，这里是停手）；
 *   ② 拿不到界面（自检 / 老版本）**停手**，不是放行（澄清那边是 fail-open）；
 *   ③ 选项写死，默认「先别动」，离场也按它走。
 *
 * ★ 2026-10-07 补的硬拦截：把「立刻停手」写进回话文本**不算数** —— 模型不听时照样
 *   调工具（真机走查逮到过：判定「没批准」后 36 秒它又执行了一次 read_file）。
 *   所以判定那一行顺带把结果记进 `core/gate-denied.cjs`，由工具咽喉
 *   `core/tools/index.cjs` 在后续每次调用前拦下。见那个模块的文件头。
 *
 * ★ 不 require electron（`transportOf` 由调用方注入）—— 自检在纯 Node 里跑。
 */

const gateDenied = require('../gate-denied.cjs')

const GATE_APPROVE_LABEL = '就按这个计划执行'
const GATE_DEFAULT_LABEL = '先别动，我再看看'

const GATE_QUESTION = (summary) => [
  {
    question: summary || '就按上面这个计划动手吗？',
    options: [
      { label: GATE_APPROVE_LABEL, effect: '现在开始动手（按上面列的那几个文件和改法）' },
      { label: GATE_DEFAULT_LABEL, effect: '这一轮到此为止，一个文件都不改' },
    ],
    defaultValue: GATE_DEFAULT_LABEL,
    allowFreeform: true,
  },
]

const GATE_APPROVED =
  '用户**批准了这个计划**。就按你上一条消息里摆出来的那份执行 —— 别扩大范围，也别再问一遍同样的事。'

const GATE_REJECTED = [
  '用户**没有批准**这个计划（他选了「先别动」、自己写了话、或者直接离开了）。**立刻停手**：',
  '- 不要再调任何工具、不要改任何文件；',
  '- 把他说要改的地方 / 你还拿不准的地方用几行写清楚；',
  '- 结束这一轮，等他回来再接着说。',
].join('\n')

const GATE_NO_CHANNEL =
  '拿不到界面（当前环境没有窗口 / 通道没接上），没法让用户确认。**为安全起见这一轮先不动手**：' +
  '把方案用几行写在回复里，等他能看到卡片时再说。' +
  '（这条和普通澄清相反 —— 那是 fail-open，这条是 fail-closed。）'

const GATE_UNATTENDED =
  '这是一次**无人值守**的运行（定时任务）：没人能确认这个计划，所以**这一轮不动手**。' +
  '把方案写进结果里留档即可（要自动执行就不该走 gate）。'

/**
 * gate 那条路：把计划摆出来问一次，只认「明确点执行」。
 *
 * @param {{ gate?: boolean, question?: string }} args
 * @param {{ taskId?: unknown, emit?: unknown }} ctx
 * @param {string} sessionId
 * @param {{ transportOf: (ctx: object) => unknown, clarify: { isUnattended: (id: string) => boolean,
 *           normalize: (raw: unknown) => object } }} deps 注入（避免与 ask_user.cjs 循环 require）
 * @returns {Promise<string>} 给模型看的一段话（放行 / 停手 / 不动手）
 */
async function runGate(args, ctx, sessionId, deps) {
  const { transportOf, clarify } = deps
  if (clarify.isUnattended(sessionId)) return GATE_UNATTENDED
  const transport = transportOf(ctx)
  if (typeof transport !== 'function') return GATE_NO_CHANNEL

  const summary = String(args?.question ?? '').trim()
  const checked = clarify.normalize(GATE_QUESTION(summary))
  let reply = null
  try {
    reply = await transport({
      kind: 'clarify',
      sessionId,
      taskId: String(ctx.taskId ?? ''),
      questions: checked.questions,
      warnings: checked.warnings,
      dropped: checked.dropped,
      emit: typeof ctx.emit === 'function' ? ctx.emit : null,
      /* ★ 让渲染层认出这是 gate 卡（不是普通澄清）：卡片只该出「执行 / 先别动」两条出口 */
      gate: true,
    })
  } catch (error) {
    return `${GATE_NO_CHANNEL}\n（提问失败：${error instanceof Error ? error.message : String(error)}）`
  }
  const approved = reply?.answers?.[0]?.choice === GATE_APPROVE_LABEL
  /* ★ 硬拦截：把结果记下来 —— 被拒之后，工具咽喉会拦下后续每一次调用 */
  if (approved) gateDenied.allow(sessionId)
  else gateDenied.deny(sessionId)
  return approved ? GATE_APPROVED : GATE_REJECTED
}

module.exports = { runGate, GATE_APPROVE_LABEL, GATE_DEFAULT_LABEL }
