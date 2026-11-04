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
/* P0-3 步骤 4：权限结论收到 Action 上（`notePermission`，只记不改判断） */
const actionCore = require('../action.cjs')

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
      actionCore.notePermission(ctx, 'path', 'bypassed')
      /*
       * 完全访问 = 不问。但**不能悄悄放行**：审计里留一条。
       * 走的是同一条授权 + 重试，只是跳过了「问」这一步。
       */
      /*
       * 只留审计，**不弹提示**（真机反馈 8）。
       *
       * 以前这里每个「工作目录之外的文件」都弹一条 toast —— 完全访问档下
       * 读一次代码库能刷出几十条，把界面糊死（用户原话：弹得没法看）。
       * 而这条信息本来就在审计里（下一行的 `pathBypass` + target + note），
       * 事后查得到，不必拿它打扰人。
       */
      auditCall(ctx, {
        tool: tool.name,
        args,
        startedAt: Date.now(),
        ok: true,
        approval: null,
        error: '',
        extras: {
          pathBypass: ctx.permission,
          sensitive: error.sensitive ?? '',
          target,
          /* 让人一眼看懂：没问是因为档位是「完全访问」，不是出了问题 */
          note: `完全访问档：未询问即放行${what}`,
        },
      })
      /*
       * ★ 授权用 `once`（用完即销），**不能**用 `session`：
       *   完全访问下放行一次就留下一条 12 小时的会话授权的话，用户之后切回
       *   「需要确认」档、那个路径也会不再问 —— 等于悄悄削弱了更严的那一档。
       * ★ C-1：会话类授权现在**必须带 sessionId**（不带会被拒，见 capability-store），
       *   而 once 用完即销、绝不跨会话 —— 正是这里要的语义。
       */
      const granted = capability.grant(target, {
        mode: 'once',
        sessionId: capability.sessionKey(ctx),
        reason: `${error.reason}（完全访问，未询问）`,
      })
      /*
       * 授权没落下来（比如这次没有会话身份）时**不能**硬重试 ——
       * 重试必然还是同一个拒绝，模型会以为工具坏了而反复试。
       */
      if (!granted?.ok) return `错误：${error.message}`
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
    if (!approved) {
      actionCore.notePermission(ctx, 'path', 'denied')
      return `用户拒绝了这个操作：访问 ${error.target}（${error.reason}）`
    }
    actionCore.notePermission(ctx, 'path', 'granted')

    /*
     * ★ C-1：敏感文件批的是**这个精确路径**（`check` 对敏感路径也只认精确授权），
     *   所以这里必须把 `error.target`（抛错时那个具体文件）当作授权对象，
     *   而不是它所在的目录。非敏感路径的行为一字未改：仍然是「批一次这个路径」，
     *   `findGrant` 对非敏感路径照旧允许父目录覆盖。
     *
     * ★ C-1（2026-11-04 复核）：`owner` 为空时**不能**退成 `once` 落盘 ——
     *   `capability-store.add` 对所有非 permanent 模式都要求 owner，于是 grant
     *   直接返回 `ok:false`，用户刚点的「允许」一点效果都没有（探针实测：批准后
     *   仍返回「需要授权才能访问」，授权表里一条记录都没有）。而真实存在这种 ctx
     *   （`codex-mcp-bridge.cjs` 的 makeCtx 既无 sessionId 也无 threadId）。
     *   无身份时走 `retryOnce`：只在**这次调用内**放行这一个精确路径，不落盘。
     *   「这次是谁」走 `capability.sessionKey`，和 `_shared.cjs` 的检查用**同一个**算法。
     */
    const owner = capability.sessionKey(ctx)
    if (!owner) return await retryOnce(tool, args, ctx, error.target)

    const granted = capability.grant(error.target, {
      mode: 'session',
      sessionId: owner,
      reason: error.reason,
    })
    if (!granted?.ok) {
      /* 授权没落下来就不要硬重试：重试必然还是同一个拒绝 */
      return `错误：${error.message}`
    }

    /* 授权过了再试一次，这次应该能过 */
    return await tool.run(args ?? {}, ctx)
  }
}

/**
 * 用户批了，但这次调用**没有会话身份** —— 落不了盘（`capability-store.add`
 * 对所有非 permanent 模式都要求 owner），于是只在**这次调用内**放行这一个精确路径。
 *
 * 三条纪律（每一条都对应一种会被踩的漏洞）：
 *
 *   ① push 之后**一定**在 finally 里删掉。ctx 是同一轮里所有工具调用共用的，
 *      忘了删就等于「批一次 = 这一轮随便用」。
 *   ② 只放行 `target` 这一个路径：`capability.approvedNow` 只做精确相等比较，
 *      不给父目录开绿灯（否则批 `D:\project` 就等于批了下面的 `.env`）。
 *   ③ **不落盘**。落了就成一条无 owner 的授权，任何别的无身份调用都能复用 ——
 *      那正是「once 被别的会话用掉」的旧病换个形状复发。
 *
 * @param {object} tool
 * @param {object} args
 * @param {object} ctx
 * @param {string} target 用户刚批准的那个绝对路径
 */
async function retryOnce(tool, args, ctx, target) {
  const owned = !Array.isArray(ctx.approvedPaths)
  const list = owned ? (ctx.approvedPaths = []) : ctx.approvedPaths
  list.push(target)
  try {
    return await tool.run(args ?? {}, ctx)
  } finally {
    const index = list.lastIndexOf(target)
    if (index >= 0) list.splice(index, 1)
    if (owned && list.length === 0) delete ctx.approvedPaths
  }
}

/*
 * ★ 2026-10-05 删掉了这里的 `notice()` 函数：它唯一的调用点（完全访问档放行
 *   文件访问）改成了**只写审计**（真机反馈 8 —— 高频提示不该弹 toast）。
 *   渲染层仍然接 `notice` 事件（见 stores/thread/noticeEvents.ts），
 *   以后确实需要「不打断但要说一声」时再把它加回来 —— 现在内核里没有发出者，
 *   留着就是死代码（lint 也会报未使用）。
 */

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
