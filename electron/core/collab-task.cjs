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
      label: pKind === 'openai' ? String(p.model ?? '') : pKind === 'codex-cli' ? 'Codex CLI' : '未选择',
    },
    executor: {
      kind: eKind,
      providerId: String(e.providerId ?? ''),
      model: String(e.model ?? ''),
      label: eKind === 'codex-cli' ? 'Codex CLI' : eKind === 'openai' ? String(e.model ?? '') : '未选择',
    },
  }
}

/** 按当前对话保存的 providerId 精确取供应商，配置变动时 fail-closed。 */
function providerForRole(config, role) {
  if (!role.kind || !role.providerId) throw new Error(`${role.label}没有选择有效模型`)
  const provider = (config.providers ?? []).find((item) => item.id === role.providerId)
  const kind = provider?.kind
  if (!provider || provider.enabled === false || kind !== role.kind)
    throw new Error(`${role.label}选择的供应商已不可用，请重新选择`)
  if (role.kind === 'openai' && (!role.model || !(provider.models ?? []).includes(role.model)))
    throw new Error(`${role.label}模型已不在所选供应商中，请重新选择`)
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
/**
 * 交给 DeepSeek 的任务正文。
 *
 * ★ 把 Codex 的计划**原样**给它，并明确「范围」—— 否则执行者容易顺手重构。
 */
function buildTask(goal, plan, projectRoot) {
  return [
    '【任务】按下面这份由指导模型给出的计划执行。',
    '',
    `项目根：${projectRoot}`,
    '',
    '要解决的问题：',
    plan.problem,
    '',
    '允许修改的文件（**只改这些**，别顺手重构别的）：',
    ...(plan.scope.length > 0 ? plan.scope.map((s) => `  · ${s}`) : ['  （计划未指定）']),
    '',
    `预期结果：${plan.expected || '（计划未声明）'}`,
    `验证方法：${plan.verify || '（计划未声明）'}`,
    '',
    '要求：',
    '  1. 先读相关源码，再动手；改动尽量小，只解决这个问题。',
    '  2. 按现有权限验证结果；有项目测试条目时优先使用，没有配置时如实说明。',
    '  3. 如果你认为计划有错，**停下来说明**，不要擅自扩大范围。',
    '',
    `用户原话：${goal}`,
  ].join('\n')
}

module.exports = { resolveRoles, providerForRole, testCommandOf, buildTask }
