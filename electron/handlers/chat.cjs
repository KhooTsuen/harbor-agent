/**
 * 对话 IPC：界面与 agent 循环之间的那层 —— 装配 loop 上下文（配置 / 工作目录 / 模式），
 * 把 loop 的事件转成渲染层能懂的消息，并把「写操作确认」变成一次 IPC 往返。
 */

const bounds = require('../core/capability-bounds.cjs')
const life = require('../core/lifecycle.cjs')
const bus = require('../core/events.cjs')
const metrics = require('../core/metrics.cjs')
const longPaste = require('../core/long-paste.cjs')
const { createEmitter } = require('../core/chat-emit.cjs')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')
const { currentHistoryLimit, lastUserText } = require('./chat-parts.cjs')
const { withRequestedModel } = require('../core/model-select.cjs')
const userConstraints = require('../core/user-constraints.cjs')
/* AG-053：两条「问一句等回话」的往返拆到 ./chat-confirm.cjs（这边贴着 300 行） */
const chatConfirm = require('./chat-confirm.cjs')
/* Codex MCP 桥：把这一轮的审批上下文按 runId 登记（见 codex-mcp-context.cjs） */
const codexMcp = require('../core/codex-mcp-lifecycle.cjs')

function register({ ipcMain, send, streams, getWorkdir, resolveWorkdir, taskEnd }) {
  chatConfirm.register({ ipcMain })
  /* ── 发起一轮对话 ─────────────────────────────────────── */

  ipcMain.handle('chat:send', async (_event, payload) => {
    const requestId = payload?.requestId ?? `req_${Date.now().toString(36)}`
    const rawHistory = Array.isArray(payload?.messages) ? payload.messages : []
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    /* 这一轮是**怎么起来的**（渲染层给）：用户发送 / 继续 / 编辑重答 / 重新生成 / 切版本。 */
    const reason = typeof payload?.reason === 'string' && payload.reason ? payload.reason : '未标注'
    const historyLimit = currentHistoryLimit()
    const history = historyLimit > 0 ? rawHistory.slice(-historyLimit) : []
    const mode = typeof payload?.mode === 'string' ? payload.mode : 'pair'

    const current = config.get()
    /* ★ 会话自己选的模型要盖过全局 —— 来由与口径见 core/model-select.cjs */
    const picked = withRequestedModel(current, payload?.model)
    const effective = picked.config
    /*
     * 预检：「有没有可用的供应商」。**按这个模型挑**（会话里可能选的是别家的模型）；
     * `activeProvider` 是 config **模块**上的函数，配置对象里没有这个字段 ——
     * 把它当配置对象的方法调，真机直接 TypeError（消息发不出去，而自检全绿）。
     */
    const provider = config.providerForModel(effective.assistant.model) ?? config.activeProvider()
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
     * ★ 这一行必须放在最后（history / mode / workdir / phaseKey 都算出来之后）——
     *   第一版写在函数开头，TDZ 让 `chat:send` 直接抛 ReferenceError：消息发不出去、
     *   日志一个字没有（真机探针逮到；第 57 组自检钉了顺序）。
     */
    const here = log.tagged(`sess…${log.shortId(sessionId)} · ${log.shortId(phaseKey)}`)
    here.info(
      `新一轮：来源=${reason} 历史=${history.length} 条 模式=${mode} 工作目录=${workdir} 模型=${effective.assistant.model}${picked.scoped ? '（会话级）' : '（全局默认）'}`,
    )

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

    /* 用时以「用户按下发送」为准（渲染层带来）；没带就退化成主进程收到的时间 */
    const startedAt = Date.now()

    /*
     * 长消息落文件（2026-10-04，见 `core/long-paste.cjs` 的文件头）。
     * 为什么在内核做：要落在**工作目录**里（内核才解析得出它），而渲染层没有
     * 「静默写文件」的通道（新开一条 IPC 是更大的改动，也不该开）；只动这一轮刚发的那条。
     * ★ 只改「发给模型的那一份」：会话文件与气泡里一直是完整原文；落了文件就发一条
     *   attachment 事件把路径显出来（不静默，不许悄悄换）。
     */
    const lastUserAt = (() => {
      for (let i = history.length - 1; i >= 0; i -= 1) if (history[i]?.role === 'user') return i
      return -1
    })()
    if (lastUserAt >= 0) {
      const planned = longPaste.offload({
        text: history[lastUserAt].content,
        workdir,
        sessionId,
      })
      if (planned.changed) {
        history[lastUserAt].content = planned.outgoing
        emit({
          type: 'attachment',
          path: planned.path,
          chars: planned.chars,
          kept: planned.kept,
          created: planned.created,
        })
        here.info(
          `长消息已落文件：${planned.path}（${planned.chars} 字符 → 发前 ${planned.kept}，${planned.created ? '新写' : '复用'}）`,
        )
      } else if (planned.error) {
        emit({
          type: 'notice',
          level: 'warning',
          title: '长消息没能落成文件',
          text: `${planned.error} —— 这条消息只能按对话预算裁剪，超出的部分模型看不到`,
        })
        here.warn(`长消息落文件失败（${planned.reason}）：${planned.error}`)
      }
    }

    const controller = new AbortController()
    /*
     * AG-011：暂停请求挂在 entry 上。
     * 「中断」（abort）和「暂停」（安全点停下）是两件事，这里各留一个口子。
     */
    const pause = { requested: false }
    streams.set(requestId, { controller, pause, sessionId })

    /* sessionId 一并带上：「需要你确认」的系统通知点开后要跳回这条对话（P1-3） */
    const confirm = (request) => chatConfirm.askUser(requestId, request, emit, sessionId)
    const latestUserText = lastUserText(history)
    const { provider: visionProvider, model: visionModel } = require('../core/codex-mcp-vision.cjs').forRun(payload, effective, provider)
    /* ★ Codex MCP 桥的审批上下文：桥按 runId 找回**这条对话**的 confirm ——
       卡于是天然绑在正确的 requestId 上（切会话不会错配）。未启用时是空操作。 */
    codexMcp.registerRun(phaseKey, {
      requestId,
      sessionId,
      confirm,
      workdir,
      permission: effective.tools.permission,
      threadSettings: payload.threadSettings ?? {},
      allowWrite: userConstraints.allowsWrite({
        userText: latestUserText,
        mode,
        threadAllowWrite: payload.threadSettings?.allowWrite,
      }),
      allowNetwork: userConstraints.allowsNetwork({
        userText: latestUserText,
        threadAllowNetwork: payload.threadSettings?.allowNetwork,
      }),
      signal: controller.signal,
      vision: { config: effective, provider: visionProvider, model: visionModel },
      ...(payload?.collab
        ? {
            collab: true,
          }
        : {}),
    })

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

        /*
         * ②-5：这句话碰到能力边界了吗 —— 碰到了先说一声，但**不拦**。
         * 放在跑之前：用处就是「别让用户等半天才发现这活不做」（见 core/capability-bounds.cjs）。
         */
        const boundary = bounds.check(lastUserText(history))
        if (boundary) emit({ type: 'boundary', ...boundary })

        const result = await require('./chat-run.cjs').runTurn({
          payload,
          history,
          rawHistory,
          effective,
          workdir,
          mode,
          controller,
          pause,
          emit,
          confirm,
          sessionId,
          phaseKey,
        })

        if (controller.signal.aborted)
          throw Object.assign(new Error('用户已停止任务'), { name: 'AbortError' })
        emit({
          type: 'done',
          content: result.content,
          reasoning: result.reasoning,
          usage: result.usage,
          turns: result.turns,
          toolRuns: result.toolRuns,
          exhausted: result.exhausted === true,
        })

        const spent = ((Date.now() - (payload?.requestTime || startedAt)) / 1000).toFixed(1)
        here.info(
          `对话完成：${result.turns} 轮，${result.toolRuns.length} 次工具调用，用时 ${spent} 秒`,
        )
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) {
          emit({ type: 'aborted' })
          here.info('对话中止（用户按了停止 / 切走了）')
        } else {
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: 'error', message })
          here.error(`对话失败：${message}`)
        }
      } finally {
        /* AG-029：这轮结束（成功/失败/中断都走 finally）→ 交给主进程决定要不要通知 */
        void taskEnd?.({ sessionId })

        /*
         * M1：一轮结束 → 立刻冲一次错误观察哨（别等 15s 定时器 / 进程退出，否则右栏
         * 角标滞后）。放 finally：它是成功 / 失败 / 中断三路唯一汇聚点。独立 try 是双保险。
         */
        try {
          require('../core/error-observer.cjs').flush()
        } catch (error) {
          console.error('flush error', error)
        }

        /* AG-011：最后一段增量还在缓存里 —— 不冲掉就永远看不见了 */
        flush()
        /* AG-003：算 TTFT / 首次工具反馈 / 总耗时，发 metrics.timeline 事件 */
        metrics.finish(phaseKey)
        /* 退订状态转发 —— 不退的话每发一条消息就多一个监听器 */
        offPhase()
        life.forget(phaseKey)
        streams.delete(requestId)
        /* 收尾：把这轮没答复的确认全部按「拒绝」处理，避免悬挂 */
        chatConfirm.closeOut(requestId)
        /* ★ 这一轮结束了 → 注销 MCP 桥的审批上下文（此后再拿它发起的审批一律被拒） */
        codexMcp.unregisterRun(phaseKey)
      }
    })()

    return { ok: true, requestId }
  })

  /* ── 中断 ─────────────────────────────────────────────── */

  ipcMain.handle('chat:abort', (_event, requestId) => {
    const entry = streams.get(requestId)
    if (!entry) return { ok: false, error: '这个请求已经结束了' }
    if (entry.controller.signal.aborted) return { ok: true, state: 'stopping' }
    entry.controller.abort()

    /* 同样的收尾：用户按了停止，那张确认卡不该还挂着 */
    chatConfirm.closeOut(requestId)
    /* 停止也等于这一轮结束 → 注销桥的审批上下文（否则那张卡还能被桥找回） */
    codexMcp.unregisterRunByRequest(requestId)
    return { ok: true, state: 'stopping' }
  })

  /* ── 暂停（AG-011）：abort 立刻断（在跑的工具也杀），pause 是**做完手上这步**再停。
   * 这里只置标记，真正停在哪由 loop 每轮开头决定（那时上一轮工具已全部跑完）。 */
  ipcMain.handle('chat:pause', (_event, requestId) => {
    const entry = streams.get(requestId)
    if (!entry) return { ok: false, error: '这个请求已经结束了' }
    entry.pause.requested = true
    return { ok: true }
  })
}

module.exports = { register }
