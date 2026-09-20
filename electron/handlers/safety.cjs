/**
 * 安全 / 可靠相关的 IPC
 *
 * 把几件「用户要能看、能管」的东西暴露给界面：
 *   · 审计日志（谁在什么时候拿什么权限做了什么）
 *   · 路径授权列表（哪些目录被放开了，能撤销）
 *   · 任务（有哪些没干完、能不能续做）
 *   · 改动事务（这次改了哪些文件、能不能整批撤）
 *   · 凭证库状态（加密了吗、有几条）
 *
 * 全部只读或显式动作，没有「顺手改点什么」的接口 ——
 * 这几个面板的价值在于**让用户看清发生了什么**。
 */

const audit = require('../core/audit.cjs')
const capability = require('../core/capability.cjs')
const task = require('../core/task.cjs')
const diagnose = require('../core/task-diagnose.cjs')
const metrics = require('../core/metrics.cjs')
const budget = require('../core/budget.cjs')
const configCore = require('../core/config.cjs')
const recovery = require('../core/task-recovery.cjs')
const changeset = require('../core/changeset.cjs')
const changesetDiff = require('../core/changeset-diff.cjs')
const credentials = require('../core/credentials.cjs')
const config = require('../core/config.cjs')
const risk = require('../core/risk.cjs')
const log = require('../core/log.cjs')

function register({ ipcMain }) {
  /* ── 审计 ─────────────────────────────────────────────── */

  ipcMain.handle('audit:list', (_event, options = {}) => ({
    ok: true,
    entries: audit.read({
      day: options.day,
      limit: Math.min(1000, Number(options.limit) || 200),
      sessionId: options.sessionId ?? '',
      tool: options.tool ?? '',
      onlyProblems: options.onlyProblems === true,
    }),
    days: audit.days(),
  }))

  ipcMain.handle('audit:stats', (_event, daysBack) => ({
    ok: true,
    stats: audit.stats(Math.min(90, Number(daysBack) || 7)),
  }))

  ipcMain.handle('audit:clear', () => {
    const result = audit.clear()
    log.info(`审计日志已清空（${result.removed} 个文件）`)
    return { ok: true, ...result }
  })

  ipcMain.handle('audit:prune', () => audit.prune())

  /** 试算一条命令的风险 —— 设置页里给用户看的示例用 */
  ipcMain.handle('risk:classify', (_event, command) => {
    const verdict = risk.classify(String(command ?? ''))
    return {
      ok: true,
      verdict,
      policy: config.get().tools.shellPolicy,
      decide: risk.decide(verdict, config.get().tools.shellPolicy),
    }
  })

  /* ── 路径授权 ─────────────────────────────────────────── */

  ipcMain.handle('capability:list', () => ({ ok: true, grants: capability.list() }))

  ipcMain.handle('capability:revoke', (_event, target) => {
    const result = capability.revoke(String(target ?? ''))
    log.info(`撤销路径授权：${target}（移除 ${result.removed} 条）`)
    return result
  })

  ipcMain.handle('capability:revokeAll', () => {
    capability.revokeAll()
    log.info('已撤销全部路径授权')
    return { ok: true }
  })

  /** 手动加一条授权（用户主动放开一个目录） */
  ipcMain.handle('capability:grant', (_event, payload = {}) => {
    const target = String(payload.path ?? '').trim()
    if (!target) return { ok: false, error: '缺路径' }
    const mode = ['once', 'session', 'permanent'].includes(payload.mode)
      ? payload.mode
      : 'permanent'
    return capability.grant(target, { mode, reason: payload.reason ?? '用户手动添加' })
  })

  /* ── 任务 ─────────────────────────────────────────────── */

  /*
   * AG-040：顺手把「这个任务实际用哪份预算」算好带上 ——
   * 内置默认 ← 设置 ← 任务自己的覆盖，只有主进程知道全貌；
   * 界面据此显示「50 / 50」并预填「调整预算」表单。
   */
  const withBudget = (record) =>
    record ? { ...record, budgetResolved: budget.resolve(configCore.get(), record) } : record

  ipcMain.handle('task:list', (_event, options = {}) => ({
    ok: true,
    tasks: task
      .list({
        limit: Math.min(200, Number(options.limit) || 30),
        status: options.status ?? '',
        sessionId: options.sessionId ?? '',
      })
      .map(withBudget),
  }))

  ipcMain.handle('task:unfinished', () => ({ ok: true, tasks: task.unfinished() }))

  /*
   * AG-012：重启后的恢复清单。
   * 比 task:unfinished 多带三样用户做决定需要知道的东西 —— 停在哪一步、
   * 停手后哪些文件被动过、恢复过几次。**纯读**，不会自己跑任务。
   */
  ipcMain.handle('task:recovery', () => ({ ok: true, items: recovery.scan() }))

  ipcMain.handle('task:get', (_event, id) => ({
    ok: true,
    task: withBudget(task.get(String(id ?? ''))),
  }))

  /*
   * AG-035：诊断报告。
   * 按需拉（不是列表里每行都算一份）：台账摊开是几百行，读成人话要花一点力气，
   * 用户点了「诊断」才值当。**纯读**，不改任务、不跑东西。
   */
  ipcMain.handle('task:diagnose', (_event, id) => ({
    ok: true,
    diagnosis: diagnose.diagnose(task.get(String(id ?? ''))),
  }))

  ipcMain.handle('task:update', (_event, payload = {}) => {
    const updated = task.update(String(payload.id ?? ''), payload.patch ?? {})
    return updated ? { ok: true, task: updated } : { ok: false, error: '任务不存在' }
  })

  /* 安全版：正在跑的任务不给删（内核自己拦，不靠界面藏按钮） */
  ipcMain.handle('task:remove', (_event, id) => task.removeSafe(String(id ?? '')))
  /* 按状态批量删（任务面板的「清空这一组」）；在跑的状态会被忽略并报回来 */
  ipcMain.handle('task:removeMany', (_event, options) =>
    task.removeMany({
      statuses: Array.isArray(options?.statuses) ? options.statuses : [],
      sessionId: String(options?.sessionId ?? ''),
    }),
  )
  /* 删对话时一并清掉这条对话的任务历史 */
  ipcMain.handle('task:purge', (_event, sessionId) => task.removeBySession(String(sessionId ?? '')))

  ipcMain.handle('task:pauseRunning', () => task.pauseRunning())

  /* ── 改动事务 ─────────────────────────────────────────── */

  ipcMain.handle('changeset:list', (_event, options = {}) => ({
    ok: true,
    changesets: changeset.list({
      limit: Math.min(100, Number(options.limit) || 20),
      taskId: options.taskId ?? '',
      sessionId: options.sessionId ?? '',
    }),
  }))

  ipcMain.handle('changeset:get', (_event, id) => ({
    ok: true,
    changeset: changeset.get(String(id ?? '')),
  }))

  ipcMain.handle('changeset:rollback', (_event, id) => {
    const result = changeset.rollback(String(id ?? ''))
    log.info(`用户回滚了一次改动：${id}（恢复 ${result.restored?.length ?? 0} 个文件）`)
    return result
  })

  /*
   * AG-036：右栏「审查」要看的「未提交的改动」。
   * 按会话取**最近一次有改动的**事务，把「改动前快照 vs 磁盘现在的样子」算成 diff。
   * 纯读：不提交、不回滚、不碰任何文件。
   */
  /* AG-037：性能面板读最近几次的时间线（纯内存，不碰磁盘） */
  ipcMain.handle('metrics:recent', (_event, payload = {}) => ({
    ok: true,
    items: metrics.list({ limit: Number(payload?.limit) || 5 }),
  }))

  ipcMain.handle('changeset:diff', (_event, payload = {}) => ({
    ok: true,
    diff: changesetDiff.latest({ sessionId: String(payload.sessionId ?? '') }),
  }))

  /* ── 凭证库状态（**不返回值**）──────────────────────────── */

  ipcMain.handle('credentials:status', () => ({ ok: true, status: credentials.status() }))
}

module.exports = { register }
