/**
 * 工具准入：路径授权与审计
 *
 * 从 index.cjs 拆出来的（那边过 300 行了）。
 * 这两件事都属于「这次调用该不该放行、放行了要留什么痕」，
 * 和工具本身干什么无关，所以单独放一处。
 */

const audit = require('../audit.cjs')
const capability = require('../capability.cjs')
const approvals = require('./approval.cjs')
const { FILE_WRITERS } = require('./registry.cjs')

/**
 * 跑一个工具；如果因为「路径在工作目录之外 / 敏感文件」被拒：
 *
 *   · `需要确认` 档 → 问一次用户，批准后给本会话授权并**重试一次**
 *   · `完全访问` 档 → **不弹窗**（2026-09-29 用户明确选的），但要**留痕**：
 *     记一条审计 + 给界面一条**不打断**的提示，然后同样授权并重试
 *
 * 只重试一次：用户可以拒绝，模型也不该在这上面反复来回。
 */
async function runWithPathPermission(tool, args, ctx) {
  try {
    return await tool.run(args ?? {}, ctx)
  } catch (error) {
    if (error?.code !== 'PERMISSION_REQUIRED') throw error
    if (typeof ctx.confirm !== 'function') return `错误：${error.message}`

    const target = String(error.target ?? '')
    const what = error.sensitive ? `敏感文件（${error.sensitive}）` : '工作目录之外的文件'

    if (ctx.permission === 'full') {
      /*
       * 完全访问 = 不问。但**不能悄悄放行**：审计里留一条、界面上弹一条 toast。
       * 走的是同一条授权 + 重试，只是跳过了「问」这一步。
       */
      auditCall(ctx, {
        tool: tool.name,
        args,
        startedAt: Date.now(),
        ok: true,
        approval: null,
        error: '',
        extras: { pathBypass: ctx.permission, sensitive: error.sensitive ?? '', target },
      })
      notice(ctx, `访问了${what}`, `${target}\n（当前是「完全访问」，按你的设置没有询问）`)
      /*
       * ★ 授权用 `once`（用完即销），**不能**用 `session`：
       *   完全访问下放行一次就留下一条 12 小时的会话授权的话，用户之后切回
       *   「需要确认」档、那个路径也会不再问 —— 等于悄悄削弱了更严的那一档。
       */
      capability.grant(target, {
        mode: 'once',
        sessionId: ctx.sessionId ?? '',
        reason: `${error.reason}（完全访问，未询问）`,
      })
      return await tool.run(args ?? {}, ctx)
    }

    const approved = await approvals.ask(ctx, {
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

/**
 * 一条**不打断**的提示（`ctx.emit` 是循环里那个事件通道）。
 *
 * 用途：某件事按用户的设置「没有问」，但用户仍应该知道它发生了 ——
 * 弹窗换成 toast，不挡人做事。拿不到通道就只留审计（照样有痕）。
 */
function notice(ctx, title, text) {
  try {
    ctx.emit?.({ type: 'notice', level: 'info', title, text })
  } catch {
    /* 提示失败不能影响主流程 */
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
