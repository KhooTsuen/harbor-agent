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
const taskContext = require('../core/task-context.cjs')
const life = require('../core/lifecycle.cjs')
const bus = require('../core/events.cjs')
const metrics = require('../core/metrics.cjs')
const { createEmitter } = require('../core/chat-emit.cjs')
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

/**
 * history 里最后一条用户消息的文字 —— 当作任务目标（任务标题）。
 * 内容可能是字符串，也可能是多模态数组（带图时），两种都认。
 */
function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return message.content.slice(0, 200)
    if (Array.isArray(message.content)) {
      const text = message.content.find((part) => part?.type === 'text')?.text
      if (typeof text === 'string') return text.slice(0, 200)
    }
  }
  return ''
}

function register({ ipcMain, send, streams, getWorkdir, resolveWorkdir, taskEnd }) {
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

    /* 同一进程里可能有多个请求并发，订阅者按这个 key 过滤 */
    const phaseKey = (typeof payload?.taskId === 'string' && payload.taskId) || requestId

    /*
     * AG-003：开始记这条任务的时间线。
     * `requestTime` 由渲染层带过来 —— 那才是「用户按下发送」的时刻，
     * 拿主进程收到 IPC 的时间会少算一段网络/调度延迟。
     */
    metrics.begin(phaseKey, { requestTime: payload?.requestTime })

    /* 事件怎么出去（总线 + 时间线 + 批处理）全在 core/chat-emit.cjs 里 */
    const { emit, flush } = createEmitter({ requestId, phaseKey, send })

    if (!provider) {
      emit({ type: 'error', message: '还没有配置供应商，去「设置 → 模型」里加一个' })
      /* 这条路径不经过下面的 finally，得自己收尾，不然时间线留在内存里 */
      metrics.finish(phaseKey)
      return { ok: false, error: '没有配置供应商' }
    }

    const controller = new AbortController()
    /*
     * AG-011：暂停请求挂在 entry 上。
     * 「中断」（abort）和「暂停」（安全点停下）是两件事，这里各留一个口子。
     */
    const pause = { requested: false }
    streams.set(requestId, { controller, pause })

    const confirm = (request) => askUser(requestId, request, emit)

    /*
     * AG-001：状态机的每次转移都推给渲染层（前端只读、不自己猜）。
     * key 用 taskId，没有就退化成 requestId —— 同一进程里可能有多个请求在跑，
     * 所以订阅者要按 key 过滤。
     */
    const offPhase = life.onTransition((e) => {
      if (e.taskId !== phaseKey) return
      /* AG-002：事件名由 eventForTransition 决定，不在这里现编字符串 ——
         状态机与事件名的对应只有一处（events.cjs）。每条都带 phase 字段。 */
      const name = bus.eventForTransition(e.from, e.to)
      emit({ type: name ?? 'phase', phase: e.to, from: e.from, detail: e.detail })
    })

    /* 不 await：立刻返回，后面靠事件推 */
    void (async () => {
      try {
        /* AG-011：带 resumeTaskId = 接着上次那条做（生命周期上是新一轮，
           会发 agent.started，但用户视角是「恢复」，补一条 agent.resumed）。 */
        if (payload?.resumeTaskId) {
          emit({
            type: 'agent.resumed',
            phase: 'thinking',
            detail: `继续任务 ${payload.resumeTaskId}`,
          })
        }

        const result = await loop.run({
          history,
          config: current,
          workdir,
          mode,
          signal: controller.signal,
          /* AG-011：让循环能问「用户是不是请求暂停了」 */
          controls: { pauseRequested: () => pause.requested },
          /* AG-011：带这个就是「接着上次那条任务做」——循环会复用原任务，
             而不是新建一条（不然「不重复已完成步骤」无从谈起） */
          resumeTaskId: typeof payload?.resumeTaskId === 'string' ? payload.resumeTaskId : '',
          emit,
          confirm,
          /* 会话 id：审计、授权、任务记录都靠它串起来 */
          sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
          projectId: typeof payload?.projectId === 'string' ? payload.projectId : '',
          /*
           * 事件流的 key（和任务台账的 id 是两回事）。
           * 状态转移订阅、总线落盘都用它 —— 之前拿任务 id 去比，永远对不上。
           */
          traceId: phaseKey,
          /*
           * 把未完成任务的台账注入提示（taskState 层）—— 模型以前不知道
           * 还有没干完的活，长对话里就是「目标漂移」。
           */
          taskState: taskContext.buildTaskState({
            sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
            taskId: typeof payload?.taskId === 'string' ? payload.taskId : '',
            /* AG-018：把用户这句话也交给它 —— 说「继续」时要明确告诉他“这是接着做” */
            userText: lastUserText(history),
          }),
          /* 拿用户那句话当任务目标：不传的话任务标题永远是「未命名任务」，
             用户根本不知道那条没干完的活是啥。 */
          goal: lastUserText(history),
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
        /* AG-029：这轮结束（成功/失败/中断都走 finally）→ 交给主进程决定要不要通知 */
        void taskEnd?.({ sessionId: payload?.sessionId ?? '' })

        /* AG-011：最后一段增量还在缓存里 —— 不冲掉就永远看不见了 */
        flush()
        /* AG-003：算 TTFT / 首次工具反馈 / 总耗时，发 metrics.timeline 事件 */
        metrics.finish(phaseKey)
        /* 退订状态转发 —— 不退的话每发一条消息就多一个监听器 */
        offPhase()
        life.forget(phaseKey)
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
    const entry = streams.get(requestId)
    if (!entry) return { ok: false, error: '这个请求已经结束了' }
    entry.controller.abort()
    streams.delete(requestId)

    for (const [id, pending] of pendingConfirms) {
      if (pending.requestId === requestId) {
        pending.resolve(false)
        pendingConfirms.delete(id)
      }
    }
    return { ok: true }
  })

  /* ── 暂停（AG-011）──
   * abort 立刻断（正在跑的工具也杀），pause 是**做完手上这步**再停。
   * 这里只置个标记，真正停在哪由 loop 每轮开头决定 —— 那个位置上
   * 上一轮工具已全部跑完，才是「完成当前安全操作」的准确含义。
   */
  ipcMain.handle('chat:pause', (_event, requestId) => {
    const entry = streams.get(requestId)
    if (!entry) return { ok: false, error: '这个请求已经结束了' }
    entry.pause.requested = true
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
      kind: request.kind ?? '',
      risk: request.risk ?? null,
      /* AG-036：会改成什么样（`write_file` / `edit_file` 才有） */
      diff: request.diff ?? null,
      diffNote: request.diffNote ?? '',
      impact: request.impact ?? [],
    })
  })
}

module.exports = { register }
