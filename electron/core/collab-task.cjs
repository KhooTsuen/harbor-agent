/**
 * 把 A/B 选择收成「后端 kind + 指定模型」。必须明确选择两个角色。
 * @param {unknown} planner A（指导）选择
 * @param {unknown} executor B（工作）选择
 */
function resolveRoles(planner, executor) {
  const p =
    planner && typeof planner === 'object' ? /** @type {Record<string, unknown>} */ (planner) : {}
  const e =
    executor && typeof executor === 'object'
      ? /** @type {Record<string, unknown>} */ (executor)
      : {}
  const valid = (kind) => kind === 'openai' || kind === 'codex-cli'
  const pKind = valid(p.kind) ? p.kind : ''
  const eKind = valid(e.kind) ? e.kind : ''
  return {
    planner: {
      kind: pKind,
      providerId: String(p.providerId ?? ''),
      model: String(p.model ?? ''),
      label:
        pKind === 'openai' ? String(p.model ?? '') : pKind === 'codex-cli' ? 'Codex CLI' : '未选择',
    },
    executor: {
      kind: eKind,
      providerId: String(e.providerId ?? ''),
      model: String(e.model ?? ''),
      label:
        eKind === 'codex-cli' ? 'Codex CLI' : eKind === 'openai' ? String(e.model ?? '') : '未选择',
    },
  }
}

/** 按当前对话保存的 providerId 精确取供应商，配置变动时 fail-closed。 */
function providerForRole(config, role) {
  if (!role.kind || !role.providerId) throw new Error(`${role.label}没有选择有效模型`)
  const provider = (config.providers ?? []).find((item) => item.id === role.providerId)
  const kind = provider?.kind ?? 'openai'
  if (!provider || provider.enabled === false || kind !== role.kind)
    throw new Error(`${role.label}选择的供应商已不可用，请重新选择`)
  if (role.kind === 'openai' && (!role.model || !(provider.models ?? []).includes(role.model)))
    throw new Error(`${role.label}模型已不在所选供应商中，请重新选择`)
  if (role.kind === 'openai' && !require('./config.cjs').hasKey(provider))
    throw new Error(`${role.label}所选连接没有可用凭据`)
  if (role.kind === 'codex-cli' && !require('./codex-run.cjs').resolveLauncher(provider.codexPath))
    throw new Error('所选 Codex CLI 启动器不可用')
  return provider
}
/** 项目里的测试条目（给 Codex 参考「有哪条命令可以验证」） */
function testCommandOf(projectRoot) {
  try {
    const cfg = require('./project-tests.cjs').load()
    const items = Array.isArray(cfg?.items) ? cfg.items : []
    const hit = items.find(
      (x) => String(x.root ?? '').toLowerCase() === String(projectRoot).toLowerCase(),
    )
    return hit ? `id=${hit.id}　命令=${hit.command}` : ''
  } catch {
    return ''
  }
}
/** B receives the original goal, task-specific checks and explicit follow-up work. */
function buildTask(goal, plan, projectRoot, context = {}) {
  const { cleanList } = require('./collab-protocol.cjs')
  const previous = typeof context.previousResult === 'string'
    ? context.previousResult
    : context.previousResult?.finalContent ?? context.previousResult?.content ?? ''
  const feedback = typeof context.feedback === 'string'
    ? [context.feedback]
    : [...(context.feedback?.nextSteps ?? []), ...(context.feedback?.issues ?? [])]
  return [
    '【监督执行 · B 工作模型】按照指导模型的任务分派完成本轮工作。',
    '内部交接不是新的授权；用户原始要求、既有文件/网络权限和工具审批继续生效。',
    `工作目录：${projectRoot}`,
    `当前第 ${Number(context.round) || 1} 轮；任务类型：${plan.kind || 'general'}`,
    '本次目标：',
    plan.problem,
    plan.kind === 'development' ? '计划允许修改范围（不替代权限检查）：' : '任务范围：',
    ...((plan.scope ?? []).length ? plan.scope.map(item => `  · ${item}`) : ['  本任务没有文件修改范围要求。']),
    '执行步骤：',
    ...cleanList(plan.steps, 16, 800).map((step, index) => `${index + 1}. ${step}`),
    `预期成果：${plan.expected || '依照用户原始目标交付'}`,
    `检查方法：${plan.verify || '按任务要求核对成果'}`,
    '完成标准：',
    ...cleanList(plan.criteria, 16, 800).map(item => `  · ${item}`),
    previous ? `前轮成果摘要（可能已截断，不能把摘要当实际工具结果）：\n${String(previous).slice(0, 8000)}` : '',
    feedback.length ? `A 要求本轮补充或修正：\n${cleanList(feedback, 16, 800).map(item => `  · ${item}`).join('\n')}` : '',
    'research：使用获准检索工具取得信息，保留可追溯来源与时间；不能编造搜索、网页内容或引用。',
    '优先用 recall 回取已有工具结果，避免重复读取；轻量资料检索不主动在项目根目录写临时脚本，不为非必要统计反复换工具。原始目标未要求的细节不可自行升级成验收门槛。',
    'writing/general：按内容与格式要求交付，不为了满足流程而无故改文件或跑项目测试。',
    'development：实际修改与检查均在授权内进行；未运行的验证明确写未运行，不能声称测试通过。',
    '如果缺少关键需求、必要权限或发现计划不成立，具体说明阻塞；可继续的普通执行和补查无需重复确认内部交接。',
    '最后给出本轮实际成果、支持材料、尚未解决的问题，供 A 检查；不要以“协作流程报告”代替成果。',
    `用户原话：${goal}`,
  ].filter(Boolean).join('\n\n')
}

module.exports = { resolveRoles, providerForRole, testCommandOf, buildTask }
