/**
 * 工具准入：路径授权与审计
 *
 * 从 index.cjs 拆出来的（那边过 300 行了）。
 * 这两件事都属于「这次调用该不该放行、放行了要留什么痕」，
 * 和工具本身干什么无关，所以单独放一处。
 */

const audit = require('../audit.cjs')
const capability = require('../capability.cjs')
const { FILE_WRITERS } = require('./registry.cjs')

/**
 * 跑一个工具；如果因为「路径在工作目录之外」被拒，问一次用户，
 * 批准后给本会话授权并**重试一次**。
 *
 * 只重试一次：用户可以拒绝，模型也不该在这上面反复来回。
 */
async function runWithPathPermission(tool, args, ctx) {
  try {
    return await tool.run(args ?? {}, ctx)
  } catch (error) {
    if (error?.code !== 'PERMISSION_REQUIRED') throw error
    if (typeof ctx.confirm !== 'function') return `错误：${error.message}`

    const approved = await ctx.confirm({
      kind: 'path',
      name: tool.name,
      args,
      path: error.target,
      reason: error.reason,
      sensitive: error.sensitive,
      summary: `让 Agent 访问 ${error.target}\n${error.reason}`,
    })
    if (!approved) return `用户拒绝了这个操作：访问 ${error.target}（${error.reason}）`

    capability.grant(error.target, {
      mode: 'session',
      sessionId: ctx.sessionId ?? '',
      reason: error.reason,
    })

    /* 授权过了再试一次，这次应该能过 */
    return await tool.run(args ?? {}, ctx)
  }
}

/* ── ④ 审计 ───────────────────────────────────────────────── */

function auditCall(ctx, entry) {
  try {
    audit.record({
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      permission: ctx.permission,
      ...entry,
    })
  } catch {
    /* 审计不影响主流程 */
  }
}

/** 这次调用动了哪些文件（给审计用） */
function affectedFiles(name, args) {
  if (!FILE_WRITERS.has(name)) return []
  return args?.path ? [String(args.path)] : []
}

module.exports = { runWithPathPermission, auditCall, affectedFiles }
