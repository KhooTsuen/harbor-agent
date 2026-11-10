/** Explicitly selected supervisor/worker workflow with bounded automatic correction. */
const { resolveRoles, providerForRole, buildTask, testCommandOf } = require('./collab-task.cjs')
const { perform } = require('./collab-supervisor.cjs')
const activeRoots = new Set()
const failed = (code, message) => ({ ok: false, accepted: false, code, message })

async function runCollaboration(input = {}) {
  if (input.selected !== true || require('./collab-config.cjs').enabled() !== true)
    return failed('COLLAB_DISABLED', '当前对话未主动选择双模型，或协作开关已关闭')
  if (!String(input.goal ?? '').trim()) return failed('NO_GOAL', '请先填写目标')
  let roles
  let providers
  let root
  try {
    roles = resolveRoles(input.planner, input.executor)
    providers = {
      planner: providerForRole(input.config, roles.planner),
      executor: providerForRole(input.config, roles.executor),
    }
    for (const key of ['planner', 'executor'])
      roles[key].label =
        `${providers[key].name || '所选连接'} · ${roles[key].kind === 'codex-cli' ? 'Codex CLI' : roles[key].model}`
    if (
      roles.planner.kind === roles.executor.kind &&
      roles.planner.providerId === roles.executor.providerId &&
      roles.planner.model === roles.executor.model
    )
      return failed('COLLAB_SELECTION_INVALID', '请选择两个不同的模型')
    const roots = require('./project-roots.cjs')
    const real = roots.realRoot(input.projectRoot)
    if (!real || roots.isForbidden(real))
      return failed('INVALID_PROJECT_ROOT', '工作目录不存在或不可用于协作')
    root = require('./tools/_shared.cjs').resolvePath(real, input.projectRoot, {
      sessionId: input.sessionId,
    })
  } catch (error) {
    return failed('COLLAB_SELECTION_INVALID', String(error?.message ?? error))
  }
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  if (activeRoots.has(rootKey))
    return failed('COLLAB_BUSY', '这个项目已有协作在运行，请先停止或等待结束')
  activeRoots.add(rootKey)
  try {
    const constraints = require('./user-constraints.cjs')
    require('./gate-denied.cjs').allow(input.sessionId)
    require('./user-grants.cjs').noteGrant(input.sessionId, {
      granted: constraints.grantsWriteIn(input.goal), stopped: constraints.noWriteIn(input.goal),
    })
    const limits = require('./collab-config.cjs').normalize(input.config?.collab)

    return await perform(
      {
        ...input,
        phaseKey:
          input.phaseKey || `collab_${require('node:crypto').randomUUID().replace(/-/g, '')}`,
        roles,
        providers,
        limits: { maxRounds: limits.maxRounds, maxRuntime: limits.maxRuntime, maxTokens: limits.maxTokens },
        signal: input.signal ?? new AbortController().signal,
      },
      root,
    )
  } finally {
    activeRoots.delete(rootKey)
  }
}


module.exports = { runCollaboration, buildTask, testCommandOf }
