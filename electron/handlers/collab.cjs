/**
 * IPC：**双模型协作**的设置与启动（2026-10-17）
 *
 * ── 通道 ──────────────────────────────────────────────────────
 *
 *   ① `collab:status` —— 开关 + 角色表 + 能否启动（缺哪个前提就直说）
 *   ② `collab:set`    —— 只改 `enabled`（角色写死，不接受外部指定）
 *   ③ `collab:run`    —— 真跑一次：Codex 规划 → 用户确认 → DeepSeek 执行 → Codex 验收
 *   ④ `collab:stop`   —— 取消这一次（杀 Codex 子进程树 / 中断 DeepSeek 的那一轮）
 *
 * ── ★ 为什么 `collab:run` 的入参只有两样 ──────────────────────
 *
 * `goal`（要做什么）与 `projectRoot`（在哪个项目里干）。
 * **没有 provider / model / codexPath / 角色字段** —— 两个角色由
 * `core/collab-config.cjs` 的 ROLES 固定，模型不能自选对手，也不能换 Provider。
 *
 * ── 审批与事件 ────────────────────────────────────────────────
 *
 * 计划确认卡走 `chat-confirm.askUser`（与工具审批**同一条** PermissionBar 通道）；
 * 事件走 `chat-emit.createEmitter`，于是 A/B 两个角色的进展会和普通工具调用
 * 出现在同一个活动记录里 —— 用户不必学一套新界面。
 *
 * ⚠️ 本文件不做任何权限判断：项目根授权、写入审批、审计全在 core 里。
 */

const log = require('../core/log.cjs')
const config = require('../core/config.cjs')
const collabConfig = require('../core/collab-config.cjs')

/** 当前状态（界面照它显示） */
function status() {
  const cfg = collabConfig.normalize(config.get()?.collab)
  let codexReady = false
  let codexNote = ''
  try {
    const { resolveLauncher } = require('../core/codex-run.cjs')
    const launcher = resolveLauncher('')
    codexReady = Boolean(launcher)
    codexNote = codexReady ? launcher : 'PATH 里没找到 codex（请先安装并登录 ChatGPT Codex CLI）'
  } catch (error) {
    codexNote = String((error && error.message) || error)
  }
  let tests = { enabled: false, count: 0 }
  try {
    const t = require('../core/project-tests.cjs').load()
    tests = { enabled: t.enabled === true, count: (t.items ?? []).length }
  } catch {
    /* 读不到就按没有 */
  }
  /* ★ 能力矩阵：每个后端 kind 现在能不能用（codex = CLI 装了没；openai = 有没有启用且有 key 的供应商） */
  const matrix = {
    'codex-cli': codexReady,
    openai: false,
  }
  try {
    const providers = (config.get()?.providers ?? []).filter(
      (p) => p && p.enabled === true && p.kind !== 'codex-cli',
    )
    matrix.openai = providers.some((p) => require('../core/config.cjs').hasKey(p) === true)
  } catch {
    /* 读不到就按不可用 */
  }
  const blockers = [
    ...(cfg.enabled ? [] : ['双模型协作没有开启']),
    ...(codexReady || matrix.openai ? [] : ['还没有可用的模型连接']),
  ]
  return {
    enabled: cfg.enabled,
    roles: collabConfig.ROLES,
    /* ★ 每个 kind 能否胜任 A/B 两个角色（界面据此过滤禁用） */
    matrix,
    ready: blockers.length === 0,
    blockers,
    codex: { ready: codexReady, note: codexNote },
    projectTests: tests,
  }
}

/** 同一时刻只允许一个协作在跑（两个协作抢同一个项目会互相覆盖） */
let running = null

function register({ ipcMain, getMainWindow }) {
  ipcMain.handle('collab:status', () => ({ ok: true, state: status() }))

  ipcMain.handle('collab:set', (_event, partial) => {
    const patch = partial && typeof partial === 'object' ? partial : {}
    /* ★ 只认 enabled；外部塞 roles / provider 一律丢掉 */
    config.patch({ collab: { enabled: patch.enabled === true } })
    log.info(`双模型协作：${patch.enabled === true ? '已开启' : '已关闭'}`)
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

    /* A/B 选择（从聊天框传来）。缺省回落旧默认 A=codex-cli B=openai。 */
    const planner = payload?.planner && typeof payload.planner === 'object' ? payload.planner : {}
    const executor = payload?.executor && typeof payload.executor === 'object' ? payload.executor : {}
    /* 能力校验：选的 kind 必须能胜任该角色（不能静默换 Provider） */
    const pKind = planner.kind === 'openai' ? 'openai' : 'codex-cli'
    const eKind = executor.kind === 'codex-cli' ? 'codex-cli' : 'openai'
    const cap = require('../core/collab-config.cjs')
    if (!cap.canRole('planner', pKind))
      return { ok: false, error: `「${pKind}」不能胜任指导模型（A）`, state: st }
    if (!cap.canRole('executor', eKind))
      return { ok: false, error: `「${eKind}」不能胜任工作模型（B）`, state: st }

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
    const emit = (event) => emitter.emit(event)
    const confirm = (request) => chatConfirm.askUser(requestId, request, emit, sessionId)
    const controller = new AbortController()
    running = { requestId, controller }

    try {
      const res = await require('../core/collab.cjs').runCollaboration({
        goal,
        projectRoot,
        config: config.get(),
        sessionId,
        signal: controller.signal,
        emit,
        confirm,
        planner,
        executor,
      })
      /* 汇报也走事件：界面按同一套渲染即可（不用为协作加一条专用通道） */
      if (res.ok === true) emit({ type: 'collab.done', report: res.report, verdict: res.review.verdict })
      else emit({ type: 'collab.error', code: String(res.code ?? 'FAILED'), message: String(res.message ?? '') })
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
      running = null
    }
  })

  ipcMain.handle('collab:stop', () => {
    if (!running) return { ok: false, error: '当前没有在跑的协作' }
    try {
      running.controller.abort()
    } catch {
      /* 已经 abort 过 */
    }
    return { ok: true }
  })
}

module.exports = { register, status }
