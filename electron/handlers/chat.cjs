/**
 * 对话 IPC
 *
 * 这是「界面」和「agent 循环」之间的那层。
 * 它负责：
 *   · 装配 loop 需要的上下文（配置、工作目录、模式）
 *   · 把 loop 吐出来的事件转成渲染层能懂的消息
 *   · 用 Promise 把「写操作确认」变成一次 IPC 往返
 */

const loop = require('../core/loop.cjs')
const config = require('../core/config.cjs')
const compact = require('../core/compact.cjs')
const log = require('../core/log.cjs')

/** confirmId -> resolve，等渲染层点「允许/拒绝」 */
const pendingConfirms = new Map()

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

function currentHistoryLimit() {
  const value = Number(config.get().assistant.historyLimit)
  return Number.isFinite(value) ? Math.max(0, Math.min(200, Math.floor(value))) : 20
}

function register({ ipcMain, send, streams, getWorkdir, resolveWorkdir }) {
  /* ── 发起一轮对话 ─────────────────────────────────────── */

  ipcMain.handle('chat:send', async (_event, payload) => {
    const requestId = payload?.requestId ?? `req_${Date.now().toString(36)}`
    const rawHistory = Array.isArray(payload?.messages) ? payload.messages : []
    const historyLimit = currentHistoryLimit()
    const history = historyLimit > 0 ? rawHistory.slice(-historyLimit) : []
    const mode = typeof payload?.mode === 'string' ? payload.mode : 'pair'

    const current = config.get()
    const provider = config.activeProvider()
    /*
     * 优先用这条会话自己的工作目录（侧栏里每条对话可以挂不同目录）。
     * 没挂 / 目录已经不存在 → 回落到默认工作目录。
     */
    const workdir = resolveWorkdir
      ? resolveWorkdir(typeof payload?.workdir === 'string' ? payload.workdir : '')
      : getWorkdir()

    if (!provider) {
      send('chat:event', {
        requestId,
        type: 'error',
        message: '还没有配置供应商，去「设置 → 模型」里加一个',
      })
      return { ok: false, error: '没有配置供应商' }
    }

    const controller = new AbortController()
    streams.set(requestId, controller)

    const emit = (event) => send('chat:event', { requestId, ...event })

    const confirm = (request) => askUser(requestId, request, emit)

    /* 不 await：立刻返回，后面靠事件推 */
    void (async () => {
      try {
        const result = await loop.run({
          history,
          config: current,
          workdir,
          mode,
          signal: controller.signal,
          emit,
          confirm,
          /* 会话 id：审计、授权、任务记录都靠它串起来 */
          sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
          projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
          taskId: typeof payload?.taskId === 'string' ? payload.taskId : '',
          temporary: payload?.temporary === true,
          threadSettings: payload?.threadSettings ?? {},
        })

        emit({
          type: 'done',
          content: result.content,
          reasoning: result.reasoning,
          usage: result.usage,
          turns: result.turns,
          toolRuns: result.toolRuns,
          exhausted: result.exhausted === true,
        })

        log.info(`对话完成：${result.turns} 轮，${result.toolRuns.length} 次工具调用`)
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) {
          emit({ type: 'aborted' })
        } else {
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: 'error', message })
          log.error(`对话失败：${message}`)
        }
      } finally {
        streams.delete(requestId)
        /* 收尾：把这轮没答复的确认全部按「拒绝」处理，避免悬挂 */
        for (const [id, entry] of pendingConfirms) {
          if (entry.requestId === requestId) {
            entry.resolve(false)
            pendingConfirms.delete(id)
          }
        }
      }
    })()

    return { ok: true, requestId }
  })

  /* ── 上下文压缩 ───────────────────────────────────────── */

  ipcMain.handle('chat:compact', async (_event, payload) => {
    /* 压缩可以单独配一个便宜的模型 —— 它只是把长内容揉成摘要 */
    const scene = require('../core/scene.cjs')
    const picked = scene.resolve('compact')
    const provider = picked.provider
    if (!provider) return { ok: false, error: '还没有配置供应商' }
    if (!config.hasKey(provider)) return { ok: false, error: `${provider.name} 还没填 API Key` }

    try {
      const summary = await compact.summarize({
        baseUrl: provider.baseUrl,
        apiKey: config.providerKey(provider),
        chatPath: provider.chatPath,
        model: payload?.model || picked.model,
        messages: Array.isArray(payload?.messages) ? payload.messages : [],
      })
      return { ok: true, summary }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /* ── 中断 ─────────────────────────────────────────────── */

  ipcMain.handle('chat:abort', (_event, requestId) => {
    const controller = streams.get(requestId)
    if (!controller) return { ok: false, error: '这个请求已经结束了' }
    controller.abort()
    streams.delete(requestId)

    for (const [id, entry] of pendingConfirms) {
      if (entry.requestId === requestId) {
        entry.resolve(false)
        pendingConfirms.delete(id)
      }
    }
    return { ok: true }
  })

  /* ── 确认答复 ─────────────────────────────────────────── */

  ipcMain.handle('chat:confirm', (_event, confirmId, approved) => {
    const entry = pendingConfirms.get(confirmId)
    if (!entry) return { ok: false, error: '这个确认已经过期了' }
    pendingConfirms.delete(confirmId)
    clearTimeout(entry.timer)
    entry.resolve(approved === true)
    return { ok: true }
  })
}

/** 问用户要不要执行某个写操作 */
function askUser(requestId, request, emit) {
  return new Promise((resolve) => {
    const confirmId = `cfm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

    const timer = setTimeout(() => {
      if (pendingConfirms.has(confirmId)) {
        pendingConfirms.delete(confirmId)
        resolve(false)
      }
    }, CONFIRM_TIMEOUT_MS)

    pendingConfirms.set(confirmId, { requestId, resolve, timer })

    emit({
      type: 'confirm_request',
      confirmId,
      toolName: request.name,
      summary: request.summary,
      args: request.args,
    })
  })
}

module.exports = { register }
