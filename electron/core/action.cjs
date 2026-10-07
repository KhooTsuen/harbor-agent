/**
 * Action（一次工具调用的统一对象）—— P0-3 架构收敛
 *
 * 现状：一次工具调用的几条判断散在四处，**没有共同挂靠点** ——
 *   · 危险度   `core/risk.cjs` 的 `classify()`（只 shell）
 *   · 规模     `core/scale.cjs` 的 `inspect()`（shell / list_dir）
 *   · 可逆性   `core/task-intent.cjs` 的 `REPLAY_UNSAFE`（全部工具，判据一处）
 *   · 权限     `core/capability.cjs`（路径类）
 * 想问「这次 `run_shell` 危不危险、大不大、能不能重跑」，得去四处拼。
 *
 * 这个文件把它们收成**一个对象**（`of()`），形状定在一处。
 *
 * ★ 只**组装**，不重复判断 —— 每一条都调**现成的那个家**（risk / scale / task-intent），
 *   绝不在这里再写一遍判据（硬约束 9：跨模块约定只有一处真相源）。
 *
 * 纯函数、**不 require electron**（自检 / 单测直接喂输入，不需要 Electron）。
 *
 * ⚠️ 接入点在 `core/tool-runner.cjs` 的 `runOne()`（每个工具调用的必经之路），
 *    分步方案见 `docs/Runtime领域模型.md` 4.2「接入设计」—— 那一步动内核、要单独提交。
 *    这份先落**形状与组装**（低风险、可单测）。
 */

const risk = require('./risk.cjs')
const scale = require('./scale.cjs')
const taskIntent = require('./task-intent.cjs')

/**
 * 组装一条 Action。
 *
 * @param {{ name?: string, args?: object, workdir?: string, userText?: string,
 *           limits?: object }} call 一次工具调用（形状与 `scale.inspect` 的入参对齐）
 * @returns {{
 *   tool: string,
 *   command: string|null,
 *   risk: { level: string, reasons: string[] }|null,
 *   scale: { level: string, kind: string|null, scope: string, estimate: object },
 *   scope: string,
 *   reversibility: 'safe'|'unsafe',
 * }}
 */
function of({ name, args = {}, workdir = '', userText = '', limits = {} } = {}) {
  const tool = String(name ?? '')
  const command = tool === 'run_shell' ? String(args?.command ?? '') : null

  /* 危险度只对命令行得通（risk.classify 吃的是命令原文）—— 别的工具交 null，别硬套 */
  const riskVerdict = command === null ? null : risk.classify(command)
  const scaleVerdict = scale.inspect({ name: tool, args, workdir, userText, limits })

  return {
    tool,
    command,
    risk: riskVerdict ? { level: riskVerdict.level, reasons: riskVerdict.reasons } : null,
    scale: {
      level: scaleVerdict.level,
      kind: scaleVerdict.kind,
      scope: scaleVerdict.scope,
      estimate: scaleVerdict.estimate,
    },
    scope: scaleVerdict.scope,
    /* 重跑会不会做出两份 —— 判据只此一处（task-intent.REPLAY_UNSAFE） */
    reversibility: taskIntent.isReplayUnsafe(tool) ? 'unsafe' : 'safe',
    /*
     * P0-3 步骤 4：这次调用的**权限结论** —— 各 gate 判完之后回填（见 `notePermission`），
     * 没判过就是 null。★ 只**记录**，不参与判断：该问该拦仍由各 gate 自己那层定
     * （理由与「这次不做什么」写在 `docs/安全模型.md` §8）。
     */
    permission: null,
  }
}

/**
 * 把某一层权限判断的**结论**收到 Action 上（P0-3 步骤 4：Permission 收到 Action 上）。
 *
 * 各 gate 判完顺手调一次（`notePermission(ctx, 'risk', 'asked')`）—— **只写字段，不改判断**。
 * `ctx.action` 不在（自检 / 直接调 `tools.execute`）就什么都不做，老路径行为一字不变。
 *
 * @param {object} ctx   这次调用的上下文（`tool-runner` 把组装好的 Action 挂成 `ctx.action`）
 * @param {string} layer 哪一层门：'risk' | 'scale' | 'path'
 * @param {string} decision 这一层的结论（如 'allowed' / 'asked' / 'blocked' / 'bypassed' / 'denied'）
 */
function notePermission(ctx, layer, decision) {
  const action = ctx?.action
  if (!action || typeof action !== 'object') return
  if (!action.permission || typeof action.permission !== 'object') action.permission = {}
  action.permission[layer] = decision
}

/** 给用户 / 日志看的一句话（危险度 + 规模 + 可逆性） */
function describe(action) {
  const bits = []
  if (action?.risk) bits.push(risk.describe(action.risk))
  if (action?.scale?.level && action.scale.level !== 'ok') bits.push(`规模：${action.scale.level}`)
  if (action?.reversibility === 'unsafe') bits.push('重跑有副作用')
  return bits.join('；') || '普通操作'
}

module.exports = { of, describe, notePermission }
