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
const changeset = require('../core/changeset.cjs')
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

  ipcMain.handle('task:list', (_event, options = {}) => ({
    ok: true,
    tasks: task.list({
      limit: Math.min(200, Number(options.limit) || 30),
      status: options.status ?? '',
      sessionId: options.sessionId ?? '',
    }),
  }))

  ipcMain.handle('task:unfinished', () => ({ ok: true, tasks: task.unfinished() }))

  ipcMain.handle('task:get', (_event, id) => ({ ok: true, task: task.get(String(id ?? '')) }))

  ipcMain.handle('task:update', (_event, payload = {}) => {
    const updated = task.update(String(payload.id ?? ''), payload.patch ?? {})
    return updated ? { ok: true, task: updated } : { ok: false, error: '任务不存在' }
  })

  ipcMain.handle('task:remove', (_event, id) => task.remove(String(id ?? '')))

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

  /* ── 凭证库状态（**不返回值**）──────────────────────────── */

  ipcMain.handle('credentials:status', () => ({ ok: true, status: credentials.status() }))
}

module.exports = { register }
