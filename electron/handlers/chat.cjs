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
const bounds = require('../core/capability-bounds.cjs')
const life = require('../core/lifecycle.cjs')
const bus = require('../core/events.cjs')
const metrics = require('../core/metrics.cjs')
const { createEmitter } = require('../core/chat-emit.cjs')
const config = require('../core/config.cjs')
const log = require('../core/log.cjs')

/** confirmId -> resolve，等渲染层点「允许/拒绝」 */
const pendingConfirms = new Map()
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/* 两个纯工具（history 长度上限、最后一句用户说了什么）搬去了 chat-parts.cjs */
const { currentHistoryLimit, lastUserText } = require('./chat-parts.cjs')

function register({ ipcMain, send, streams, getWorkdir, resolveWorkdir, taskEnd }) {
  /* ── 发起一轮对话 ─────────────────────────────────────── */

  ipcMain.handle('chat:send', async (_event, payload) => {
    const requestId = payload?.requestId ?? `req_${Date.now().toString(36)}`
    const rawHistory = Array.isArray(payload?.messages) ? payload.messages : []
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    /*
     * 这一轮是**怎么起来的**（渲染层给）：用户发送 / 点继续 / 编辑后重答 /
     * 重新生成 / 切提问版本。
     *
     * ★ 加这个的原因是查一个 bug 查了四轮：日志里只看到「又跑了一轮」，
     *   完全不知道是谁让它跑的（切版本？自动重试？还是用户自己发的），
     *   只能靠时间戳猜。现在这一行直接说出来。
     */
    const reason = typeof payload?.reason === 'string' && payload.reason ? payload.reason : '未标注'
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
     * ★ 这一行必须放在最后（history / mode / workdir / phaseKey 都算出来之后）。
     *   第一版图省事写在函数开头 —— TDZ：`phaseKey`、`workdir` 都还没初始化，
     *   结果 `chat:send` 直接抛 ReferenceError，**消息根本发不出去**，
     *   而且日志里一个字都没有（因为就抛在这一行）。
     *   真机探针逮到的；第 57 组自检里钉了顺序，改回去会红。
     */
    const here = log.tagged(`sess…${log.shortId(sessionId)} · ${log.shortId(phaseKey)}`)
    here.info(`新一轮：来源=${reason} 历史=${history.length} 条 模式=${mode} 工作目录=${workdir}`)

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

        /*
         * ②-5：这句话碰到能力边界了吗 —— 碰到了先说一声，但**不拦**。
         * 放在跑之前（而不是跑完）：它的用处就是「别让用户等半天才发现这活不做」。
         * 模式写得窄，宁可漏报也不吵（见 core/capability-bounds.cjs）。
         */
        const boundary = bounds.check(lastUserText(history))
        if (boundary) emit({ type: 'boundary', ...boundary })

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
          /* 重新生成：被替代那条回答的磁盘 key + 是否最后一轮
             （挂台账 regeneratedFrom / 标旧改动事务，见 core/task-regen.cjs） */
          regenerateOf: typeof payload?.regenerateOf === 'string' ? payload.regenerateOf : '',
          regenerateLast: payload?.regenerateIsLast === true,
          emit,
          confirm,
          /* 会话 id：审计、授权、任务记录都靠它串起来 */
          sessionId,
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
            sessionId,
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

        const spent = ((Date.now() - (payload?.requestTime || startedAt)) / 1000).toFixed(1)
        here.info(`对话完成：${result.turns} 轮，${result.toolRuns.length} 次工具调用，用时 ${spent} 秒`)
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
      /*
       * 审批 id（`approve_…`）**不能叫 requestId** —— 那是**对话的** requestId，
       * 两者同名会被上层展开覆盖，渲染层就收不到这条确认了（见 chat-emit.cjs）。
       */
      approvalId: request.requestId ?? null,
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
