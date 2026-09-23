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
 *
 * ── 后来又补的两件（审批中心的最小切片）──
 *
 *   ③ **兜底超时**：`ctx.confirm` 永不 resolve 就等于把这条工具调用永久挂起
 *      （tools/break-test-loop.mjs 的 D7 段实测过：8 秒没动静）。
 *      界面层（handlers/chat.cjs 的 CONFIRM_TIMEOUT_MS）也有超时，
 *      但工具层不能把「不挂死」寄托在调用方身上 —— 超时按**拒绝**处理。
 *
 *   ④ **每条确认有 id**：`requestId` 写进请求体和台账，日志/界面/台账
 *      以后能对上同一条；`list(ctx)` 是读口，供后续 Approval Center 用。
 *
 * ── 审批中心（Approval Center）这一轮补的两件 ──
 *
 *   ⑤ **每条审批带 `scope`**：这次批准**管到哪儿**（一次性 / 本会话 / 永久）。
 *      以前一律记成 `once`，于是界面看不出「这条是永久授权」，也就没法只给
 *      永久的那几条配「撤销」按钮 —— 「给出去的权限要能收回来」缺的就是这个字段。
 *
 *   ⑥ `list(ctx)` 改成**最新在前**、字段归一化：它现在是界面的读口，
 *      不再是台账快照 —— 界面要的是「最近发生了什么」，而且旧记录
 *      （加 id 之前写的那些）字段不全也不该把界面带崩。
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

/**
 * 等用户答复的兜底上限。
 * 界面层的超时是 5 分钟（handlers/chat.cjs），工具层故意留得更宽 ——
 * 它只在**上层彻底失灵**（弹窗没弹出来、答复消息丢了）时才该响，
 * 正常的「用户去泡了杯咖啡再点允许」不该被判超时。
 * 测试会传 `ctx.confirmTimeoutMs` 覆盖它。
 */
const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 「超时」和「用户答复了假值」必须分得开 —— 台账上这两种要看得出来。
 * 用 Symbol 是因为它不可能等于 confirm 的任何返回值（包括 true）。
 */
const TIMED_OUT = Symbol('approval-timed-out')

/** 确认实体的 id：`approve_<时间戳>_<6 位随机>`（前缀是固定的，人眼好认） */
function newRequestId() {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `approve_${Date.now()}_${suffix}`
}

/**
 * 这次批准管到哪儿：
 *
 *   once       一次性（缺省）—— 只放行这一次，用完就没了
 *   session    本会话 —— 这条对话里一直有效
 *   permanent  永久 —— 落在授权文件里，**只有这一档能撤**（审批中心的重点）
 *
 * 认不出来的值一律当 `once`：这条路上唯一允许的犯错方向是「多问用户一次」。
 */
const SCOPES = ['once', 'session', 'permanent']
const DEFAULT_SCOPE = 'once'

function scopeOf(value) {
  const scope = String(value ?? '')
  return SCOPES.includes(scope) ? scope : DEFAULT_SCOPE
}

/** 这次等多久：`ctx.confirmTimeoutMs` 优先（测试传短的），否则默认 10 分钟 */
function timeoutMsOf(ctx) {
  const custom = Number(ctx?.confirmTimeoutMs)
  return Number.isFinite(custom) && custom > 0 ? custom : DEFAULT_CONFIRM_TIMEOUT_MS
}

/** 记一笔「用户批准了什么」—— 失败不影响工具执行 */
function record(ctx, entry) {
  try {
    const task = taskCore.get(String(ctx.taskId ?? ''))
    if (!task) return
    /* 只留最近 50 条：这个是给人看的线索，不是审计流水（审计在 audit.cjs） */
    const list = [
      ...(task.permissions ?? []),
      /* `scope` 放在最后展开：台账里只允许出现那三种，别的都归一成一次性 */
      { at: Date.now(), ...entry, scope: scopeOf(entry?.scope) },
    ].slice(-50)
    taskCore.update(task.id, { permissions: list })
  } catch (error) {
    log.warn(`记权限决定失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 问一次，带兜底超时。
 *
 * 超时后**不再等**原 Promise —— `Promise.race` 天然如此：它不阻塞，
 * 也不会把迟到的结果塞回来（那份答复会被直接丢弃；`chat:confirm` 那边
 * 对已过期的 confirmId 会自己报「这个确认已经过期了」）。
 * 定时器必须 clearTimeout，否则一条 timer 就能把进程吊住。
 */
async function raceConfirm(ctx, request) {
  let timer = null
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMsOf(ctx))
  })
  try {
    return await Promise.race([ctx.confirm(request), expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 问用户一次（或者被告知「这类已经批过了」）。
 *
 * @param {object} ctx  工具上下文；`ctx.granted` 是本轮已批准的类型集合（跨轮保留），
 *                      `ctx.confirmTimeoutMs` 可覆盖兜底超时
 * @param {{ kind: string, name?: string, args?: object, summary?: string, scope?: string }} request
 *        会**被就地写入** `requestId` —— 调用方因此也能拿到本次确认的 id
 *        `scope` 说明这次批准管到哪儿（缺省 `once`），原样记进台账
 * @returns {Promise<boolean>} true = 允许；超时按**拒绝**（false）
 */
async function ask(ctx, request) {
  const kind = String(request.kind ?? '')
  const name = request.name ?? ''
  /*
   * 每次生成 id 并写回请求体：界面/日志/台账要能对上「同一条确认」。
   * 写回 request 而不是另起返回对象 —— 三个调用点一直在用布尔返回值
   * （`!== true` 的严格语义），改返回值会把它们全带偏。
   */
  const requestId = newRequestId()
  request.requestId = requestId
  /* 这次批准管到哪儿 —— 调用方可以点名 session/permanent，缺省一次性 */
  const scope = scopeOf(request.scope)

  /* ctx.granted 是 Map<类型, 批准时刻>（跨轮保留） */
  const grantedAt = ctx.granted?.get(kind)

  if (REMEMBERED.has(kind) && grantedAt && Date.now() - grantedAt < GRANT_WINDOW_MS) {
    /* 窗口内已经批过这一类 —— 不再打扰，但记一笔「这条是靠上面的批准放行的」。
       它确实被放行了（`approved: true`），只是没问人 —— 照实记，别让它看起来像没发生 */
    record(ctx, { requestId, kind, name, scope, auto: true, approved: true })
    return true
  }

  const answer = await raceConfirm(ctx, request)

  if (answer === TIMED_OUT) {
    /*
     * 超时就是拒绝（fail-closed）：没人答复 == 没被允许。
     * 绝不能往「反正用户没反对」的方向兜 —— 这个方向错一次，
     * 一个卡死的弹窗就等于静默放行了后面的所有操作。
     */
    record(ctx, { requestId, kind, name, approved: false, timedOut: true, scope })
    log.warn(`权限确认超时（${timeoutMsOf(ctx)}ms 没有答复）：${kind} ${name} —— 按拒绝处理`)
    return false
  }

  const ok = answer === true
  if (ok) {
    if (REMEMBERED.has(kind)) ctx.granted?.set(kind, Date.now())
    record(ctx, { requestId, kind, name, approved: true, scope })
  } else {
    /*
     * AG-035：「被拒绝」也要记。
     * 以前只在批准时记 —— 于是任务停下来的时候，台账上看不出
     * 「是用户点的拒绝」，诊断报告只能猜。
     */
    record(ctx, { requestId, kind, name, approved: false, scope })
  }
  return ok
}

/**
 * 读台账里最近的权限决定（Approval Center 的读口）。
 *
 * 不新开存储：approvals 一直记在 `task.permissions`（AG-012 的字段），
 * 这里只是给调用方一个统一的读口 —— 以后想换存储只改这一处。
 *
 * ★ **最新在前**：台账本身是追加写的（末尾最新），这里翻过来。
 *   界面要看的是「最近发生了什么」，没人愿意为了看最新一条先滚到底。
 *
 * 字段全部归一化过：加 `requestId` / `scope` 之前写的旧记录缺字段，
 * 这里补默认值（空串 / `once`），调用方不用到处写 `?? `。
 *
 * @param {{ taskId?: string }} ctx
 * @returns {Array<{ requestId: string, kind: string, name: string, at: number,
 *                   approved: boolean, timedOut: boolean, scope: string }>} 最多 50 条
 */
function list(ctx) {
  try {
    const task = taskCore.get(String(ctx?.taskId ?? ''))
    const entries = Array.isArray(task?.permissions) ? task.permissions : []
    return entries
      .slice()
      .reverse()
      .map((entry) => ({
        requestId: String(entry?.requestId ?? ''),
        kind: String(entry?.kind ?? ''),
        name: String(entry?.name ?? ''),
        at: Number(entry?.at) || 0,
        approved: entry?.approved === true,
        timedOut: entry?.timedOut === true,
        scope: scopeOf(entry?.scope),
      }))
  } catch (error) {
    log.warn(`读权限台账失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}

module.exports = {
  ask,
  list,
  SCOPES,
  scopeOf,
  REMEMBERED,
  GRANT_WINDOW_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
}
