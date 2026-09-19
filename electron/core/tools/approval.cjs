/*
 * AG-013：确认的统一入口
 *
 * 改造前，四类确认各自调 `ctx.confirm`（散在 tools/index.cjs 三处、
 * tools/permission.cjs 一处）。每处单独看都没问题，合起来就变成：
 * 一轮任务里连着弹四个框，用户要点四次「允许」—— 点到手酸之后就闭眼点了，
 * 这比不多问还危险。
 *
 * 这里加两件事：
 *
 *   ① **记住本轮批过的类型**。文档的按钮文案写的是「允许本次」，
 *      这就是它的字面含义：同类操作在这一轮里不再问。
 *      （这也是 AG-014「禁止连续弹出大量确认框」的实现。）
 *
 *   ② **高危永远不记**。文档另一句是「高风险操作单独确认」——
 *      所以 `risk` 这类每次都要问；`path` 同理（每个路径的风险不一样，
 *      批了一个不等于批了全部）。
 *
 * 顺带把「用户批了什么」记进任务台账的 `permissions`（AG-012 留的字段）。
 */

const taskCore = require('../task.cjs')
const log = require('../log.cjs')

/**
 * 批过一次之后，多久之内同类不再问。
 *
 * ★ 这个数字是从真机验证里改出来的：最初把「本次」定成**这一轮**，
 *   结果同一个任务里模型分了三轮写文件，弹了三次框 —— 正是 AG-014 要消灭的现象。
 *   文档举的例子是「修改 3 个文件 + 运行测试」列成**一张单子**，
 *   那些操作在时间上是挨着的，所以按**时间窗口**放行才符合它的意图。
 *   隔了几分钟之后再动文件，是另一回事了 —— 那时候重新问一次。
 */
const GRANT_WINDOW_MS = 2 * 60 * 1000

/**
 * 批过一次、窗口内就不再问的类型。
 * 只放**同一类操作风险同质**的；`risk` / `path` 不放（理由见文件头）。
 */
const REMEMBERED = new Set(['write', 'mcp'])

/** 记一笔「用户批准了什么」—— 失败不影响工具执行 */
function record(ctx, entry) {
  try {
    const task = taskCore.get(String(ctx.taskId ?? ''))
    if (!task) return
    /* 只留最近 50 条：这个是给人看的线索，不是审计流水（审计在 audit.cjs） */
    const list = [...(task.permissions ?? []), { at: Date.now(), ...entry }].slice(-50)
    taskCore.update(task.id, { permissions: list })
  } catch (error) {
    log.warn(`记权限决定失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 问用户一次（或者被告知「这类已经批过了」）。
 *
 * @param {object} ctx  工具上下文；`ctx.granted` 是本轮已批准的类型集合
 * @param {{ kind: string, name?: string, args?: object, summary?: string }} request
 * @returns {Promise<boolean>} true = 允许
 */
async function ask(ctx, request) {
  const kind = String(request.kind ?? '')
  /* ctx.granted 是 Map<类型, 批准时刻>（跨轮保留） */
  const grantedAt = ctx.granted?.get(kind)

  if (REMEMBERED.has(kind) && grantedAt && Date.now() - grantedAt < GRANT_WINDOW_MS) {
    /* 窗口内已经批过这一类 —— 不再打扰，但记一笔「这条是靠上面的批准放行的」 */
    record(ctx, { kind, name: request.name ?? '', auto: true })
    return true
  }

  const ok = (await ctx.confirm(request)) === true
  if (ok) {
    if (REMEMBERED.has(kind)) ctx.granted?.set(kind, Date.now())
    record(ctx, { kind, name: request.name ?? '', approved: true })
  } else {
    /*
     * AG-035：「被拒绝」也要记。
     * 以前只在批准时记 —— 于是任务停下来的时候，台账上看不出
     * 「是用户点的拒绝」，诊断报告只能猜。
     */
    record(ctx, { kind, name: request.name ?? '', approved: false })
  }
  return ok
}

module.exports = { ask, REMEMBERED, GRANT_WINDOW_MS }
