/**
 * IPC：**双模型协作**的设置与启动（2026-10-17）
 *
 * ── 通道 ──────────────────────────────────────────────────────
 *
 *   ① `collab:status` —— 开关 + 角色表 + 能否启动（缺哪个前提就直说）
 *   ② `collab:set`    —— 功能开关与协作预算；角色由当前对话明确选择
 *   ③ `collab:run`    —— A 分派 → B 执行 → A 检查，按预算补充或交付
 *   ④ `collab:stop`   —— 取消这一次（杀 Codex 子进程树 / 中断 DeepSeek 的那一轮）
 *
 * ── 审批与事件 ────────────────────────────────────────────────
 *
 * 需要用户决策的确认走 `chat-confirm.askUser`（复用 PermissionBar 通道）；
 * 事件走 `chat-emit.createEmitter`，于是 A/B 两个角色的进展会和普通工具调用
 * 出现在同一个活动记录里 —— 用户不必学一套新界面。
 *
 * ⚠️ 本文件不做任何权限判断：项目根授权、写入审批、审计全在 core 里。
 */

const log = require('../core/log.cjs')
const config = require('../core/config.cjs')

const { status } = require('../core/collab-status.cjs')

/** 同一时刻只允许一个协作在跑（两个协作抢同一个项目会互相覆盖） */
let running = null

function register({ ipcMain, getMainWindow }) {
  ipcMain.handle('collab:status', () => ({ ok: true, state: status() }))

  ipcMain.handle('collab:set', (_event, partial) => {
    const patch = partial && typeof partial === 'object' ? partial : {}
    const collab = require('../core/collab-config.cjs')
    const current = collab.normalize(config.get().collab)
    const allowed = Object.fromEntries(
      collab.COLLAB_KEYS.filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]),
    )
    const next = collab.normalize({ ...current, ...allowed })
    config.patch({ collab: next })
    log.info(`双模型协作设置已更新：${next.enabled ? '已开启' : '已关闭'}`)
    return { ok: true, state: status() }
  })

  ipcMain.handle('collab:run', async (_event, payload) => {
    const st = status()
    if (running) return { ok: false, error: '已经有一次协作在跑 —— 等它结束或先停止', state: st }
    if (!st.enabled) return { ok: false, error: '双模型协作没有开启', state: st }

    const goal = typeof payload?.goal === 'string' ? payload.goal.trim() : ''
    const projectRoot = typeof payload?.projectRoot === 'string' ? payload.projectRoot.trim() : ''
    if (!goal) return { ok: false, error: '请先说要做什么（目标不能为空）', state: st }
    if (!projectRoot) return { ok: false, error: '请先指定项目根', state: st }

    const { resolveRoles, providerForRole } = require('../core/collab-task.cjs')
    const planner = payload?.planner
    const executor = payload?.executor
    try {
      const roles = resolveRoles(planner, executor)
      providerForRole(config.get(), roles.planner)
      providerForRole(config.get(), roles.executor)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), state: st }
    }

    const win = typeof getMainWindow === 'function' ? getMainWindow() : null
    if (!win || win.isDestroyed?.())
      return { ok: false, error: '主窗口不可用 —— 起不了审批通道', state: st }

    const { randomUUID } = require('node:crypto')
    const requestId = `collab_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    const { createEmitter } = require('../core/chat-emit.cjs')
    const chatConfirm = require('./chat-confirm.cjs')
    const send = (channel, body) => {
      try {
        if (!win.isDestroyed?.()) win.webContents.send(channel, body)
      } catch {
        /* 窗口关了就算了：事件推送失败不该让协作崩 */
      }
    }
    const emitter = createEmitter({ requestId, phaseKey: requestId, send })
    const emit = emitter.emit
    const confirm = (request) => chatConfirm.askUser(requestId, request, emit, sessionId)
    const controller = new AbortController()
    running = { requestId, controller }

    try {
      const res = await require('../core/collab.cjs').runCollaboration({
        goal,
        selected: true,
        phaseKey: requestId,
        projectRoot,
        config: config.get(),
        sessionId,
        signal: controller.signal,
        emit,
        confirm,
        closePending: () => chatConfirm.closeOut(requestId),
        planner,
        executor,
      })
      /* 用户正文与内部协作报告分开；中断时也保留可用的文字成果。 */
      if (res.finalContent) emit({ type: 'content', text: res.finalContent, stage: 'answer' })
      if (res.ok === true)
        emit({
          type: 'collab.done',
          report: res.finalContent,
          finalContent: res.finalContent,
          collaboration: res.collaboration,
          verdict: res.review?.verdict,
          accepted: res.accepted === true,
        })
      else
        emit({
          type: 'collab.error',
          code: String(res.code ?? 'FAILED'),
          message: String(res.message ?? ''),
          finalContent: res.finalContent,
          collaboration: res.collaboration,
        })
      return {
        ok: res.ok === true,
        result: res,
        error: res.ok === true ? '' : String(res.message ?? ''),
        state: status(),
      }
    } catch (error) {
      log.warn(`双模型协作失败：${error instanceof Error ? error.message : error}`)
      emit({
        type: 'collab.error',
        code: 'THROWN',
        message: String((error && error.message) || error),
      })
      return { ok: false, error: String((error && error.message) || error), state: status() }
    } finally {
      chatConfirm.closeOut(requestId)
      emitter.flush()
      running = null
    }
  })

  ipcMain.handle('collab:stop', () => {
    if (!running) return { ok: false, error: '当前没有在跑的协作' }
    try {
      running.controller.abort()
      require('./chat-confirm.cjs').closeOut(running.requestId)
    } catch {
      /* 已经 abort 过 */
    }
    return { ok: true }
  })
}

module.exports = { register, status }
