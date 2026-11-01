import type { Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { sendChat, subscribeChatEvents } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { usePerfStore } from '../usePerfStore'
import { runPostTurnTasks } from './sceneTasks'
/* A1：收口 phase（从本文件拆出去 —— 见 turnPhase.ts 的说明） */
import { applyTerminalPhase } from './turnPhase'
import { handleStreamEvent, type StreamState } from './streamEvents'
import { buildHistory } from './history'
import { guardSendableImages } from './sendGuard'
import { buildSendPayload } from './turnPayload'
import {
  beginTurnRequest,
  disposeTurnWatchdog,
  drainQueued,
  endTurnRequest,
  registerTurnWatchdog,
  stopActiveRequest,
  type TurnSetter,
} from './turnControl'
import { createReplyPersistence } from './replyPersistence'
/* 重试起点：`retry` 时要把这一轮已经流出去的半截退掉（见 retryRollback.ts） */
import { markRoundStart } from './retryRollback'
import { createTurnWatchdog } from './turnWatchdog'
import { drainPendingRegen } from './regenQueue'
import { questionTargetOf, existingAnswersAfter } from '@/lib/answers'
import type { StoredMessage } from '@/types/models-extra'
import { logError } from '@/lib/actionLog'

/* ══════════════════════════════════════════════════════════════
   一轮对话的两条实现路径

   **Electron** → 真流式：agent 循环、工具调用、写操作确认；**浏览器预览** → 静态回复。
   两条路产出的 Message 形状一样，UI 不用关心走的哪条。本文件只负责「怎么产生回复」，
   不负责 store —— 所以写成纯函数，由 useThreadStore 调用。
   ══════════════════════════════════════════════════════════════ */

/* 「在跑的那几个请求」（登记 / 停止 / 暂停 / 排队）搬到了 turnControl.ts —— 那边自成一体，
   而这个文件贴着 300 行红线。这里**原样再导出**，外部（useThreadStore / regenerate / 测试）的导入路径不用改。 */
export {
  drainQueued,
  pauseActiveRequest,
  stopActiveRequest,
  waitForTurnEnd,
  type ThreadPartial,
  type TurnSetter,
} from './turnControl'

/* ══════════════════════════════════════════════════════════════
   路径 A：真实后端（Electron）
   ══════════════════════════════════════════════════════════════ */

/**
 * **连续这么久没有新内容**才算卡住（旧语义是「一轮最多跑这么久」—— 那个语义本身就是这次修的 bug，见 turnWatchdog.ts）。
 * 抽成常量是为了能在测试里断言它 —— 也让「改了时长」这件事看得见。
 */
export const TURN_TIMEOUT_MS = 5 * 60 * 1000

export async function runElectronTurn(
  threadId: string,
  _userText: string,
  set: TurnSetter,
  /* AG-011：带这个就是「接着上次那条任务做」——主进程会复用原任务 */
  resumeTaskId = '',
  opts: {
    /**
     * 这一版**原来那条回答**（编辑 / 重新生成时被换掉的那条）。★ 必须由调用方传：
     * 那些路会先 `removeMessagesAfter` 把它从列表里去掉，这里再去「提问后面找」就找不到了。
     */
    seedAnswers?: StoredMessage[]
    /** 这一轮是怎么起来的（只进日志）：用户发送 / 点继续 / 编辑后重答 / 重新生成 / 重试 */
    reason?: string
    /** 「重新生成」的关联：被替代那条的磁盘 key —— 落盘记 regeneratedFrom，发给主进程挂台账 */
    regeneratedFrom?: string
    /** 重新生成的是不是最后一轮（只有它是，旧台账 / 旧事务才一定属于它） */
    regenerateIsLast?: boolean
    /** 兜底时钟的「静默阈值」覆盖值 —— **只给测试用**（默认 `TURN_TIMEOUT_MS`），真机不改 */
    turnSilenceMs?: number
    origin?: 'edge-sidepanel'
  } = {},
): Promise<void> {
  const seedAnswers = opts.seedAnswers ?? []
  /* AG-003：用户按下发送的时刻 —— 主进程的 TTFT 等等都是从这一刻开始算的 */
  const requestTime = Date.now()
  /*
   * AG-037：同一个时刻也交给性能面板 —— 它要算「首字上屏」，那是渲染层
   * 自己这一段（IPC + React），主进程测不到。
   */
  usePerfStore.getState().beginRun(requestTime)

  const app = useAppStore.getState()
  const ui = useUIStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return
  const mode = thread.mode

  /* ★ 必须在 addMessage（占位消息）**之前**取：占位一加进去，「已有回答」就变成它自己了 */
  const target = questionTargetOf(thread.messages)
  const seed = seedAnswers.length ? seedAnswers : existingAnswersAfter(thread.messages, target)

  /* 流式消息：内容随真实事件逐步长出来 */
  const placeholder: Message = {
    id: uid('msg'),
    threadId,
    role: 'assistant',
    content: '',
    reasoning: '',
    kind: 'text',
    status: 'streaming',
    timestamp: Date.now(),
    toolRuns: [],
    ...(target ? { answersKey: target.key, answersVersion: target.version } : {}),
    /* 旧回答跟着一起走 —— 回答下面的 ‹ n / N › 靠它能切回去 */
    ...(seed.length ? { answerRecords: seed, answerIndex: seed.length } : {}),
    ...(opts.regeneratedFrom ? { regeneratedFrom: opts.regeneratedFrom } : {}),
  }
  app.addMessage(threadId, placeholder)
  /* AG-001：以前这里 setThreadStatus('running') —— 渲染层自己宣布「在跑」。现在状态由主进程推。 */

  const requestId = uid('req')
  beginTurnRequest(threadId, requestId)
  set((s) => ({ sendingThreads: [...new Set([...s.sendingThreads, threadId])] }))

  /** 工具调用累积（id -> record） */
  const toolRuns: ToolRunRecord[] = []
  const citations: Message['citations'] = []
  let reasoning = ''
  let content = ''

  const patch = (fields: Partial<Message>): void => {
    useAppStore.getState().updateMessage(threadId, placeholder.id, fields)
  }

  /* 历史消息喂给主进程（system 由主进程自己拼，不重复发）—— 拼法见 history.ts */
  const rawHistory = buildHistory(
    useAppStore.getState().threads.find((t) => t.id === threadId)?.messages ?? [],
    placeholder.id,
  )
  /* ★ 发送前最后一道：把要发的图全部归整一遍（规则见 sendGuard.ts —— 旧会话里的超大图会 400） */
  const guarded = await guardSendableImages(rawHistory)
  if (!guarded.ok) {
    /* 这次发送没有真正开始，不能给用户留个永远转圈的占位消息 */
    endTurnRequest(threadId)
    useAppStore.getState().updateMessage(threadId, placeholder.id, {
      status: 'error',
      content: `（发送中止）${guarded.error}`,
    })
    set((s) => ({ sendingThreads: s.sendingThreads.filter((id) => id !== threadId) }))
    ui.showToast('error', '有图片发不出去', guarded.error)
    return
  }
  const history = guarded.history

  let off: () => void = () => {}
  let finished = false
  /** 最后一个事件类型 —— 收尾时靠它决定线程状态（成功/失败/取消） */
  let lastEventType = 'done'
  /** 收尾的「为什么」：只有非事件路径才需要显式给（兜底超时 / 发送失败）；空 = 看 lastEventType */
  let finishReason = ''

  /*
   * 助手回复的落盘（分段落盘 + 收尾那条）—— 实现与来由见 replyPersistence.ts。
   * 这里只把「当前内容是什么」的读法交给它，避免闭包里那几份拷贝互相不同步。
   */
  const persistence = createReplyPersistence({
    threadId,
    messageId: placeholder.id,
    timestamp: placeholder.timestamp,
    ...(target ? { answersKey: target.key, answersVersion: target.version } : {}),
    ...(opts.regeneratedFrom ? { regeneratedFrom: opts.regeneratedFrom } : {}),
    getContent: () => content,
    getReasoning: () => reasoning,
    getEventType: () => lastEventType,
  })

  /**
   * 收尾。**只在收到结束事件时调用** —— 踩过的坑：以前写在 sendChat 后面的 finally 里，
   * 但 sendChat 是立刻返回的（循环在后台跑），订阅刚建立就被取消，done 全丢、界面永远「正在处理」。
   */
  const finish = (): void => {
    if (finished) return
    finished = true
    /* A1（Phase 5）：收口 phase —— 否则「终止事件没到达」= UI 永久卡「运行中」（见 turnPhase.ts） */
    applyTerminalPhase(threadId, finishReason || lastEventType)
    /* ★ 先把「正在跑」摘掉，**再**落盘：2026-10-04 事故里落盘先抛异常 → 界面永远停在「运行中」 */
    set((s) => ({ sendingThreads: s.sendingThreads.filter((id) => id !== threadId) }))
    /* A3：把兜底时钟拆掉（收尾与「停止」共用这一条，见 turnControl.disposeTurnWatchdog） */
    disposeTurnWatchdog(threadId)
    off()
    endTurnRequest(threadId)
    try {
      persistence.persistReply()
    } catch (error) {
      logError('turn.persistReply', error)
    }
    drainPendingRegen(threadId)
    /* AG-025：这条跑完了，自动发排队的下一条 */
    if (lastEventType === 'done' && !finishReason) drainQueued(threadId)
  }

  /* 兜底时钟超阈值时的收口：**先叫停主进程**（A2，复用 chat:abort）——只放弃接收不叫停的话，
     后台继续跑到完，done 落进已退订的订阅被静默丢弃（就是本 bug 的形状）。 */
  const onTurnTimeout = (): void => {
    stopActiveRequest(threadId)
    finishReason = 'timeout'
    finish()
    try {
      patch({ status: 'sent', content: content || '（长时间没有新内容，已停止接收）' })
      useAppStore.getState().setThreadStatus(threadId, 'error')
    } catch (error) {
      logError('turn.timeout', error)
    }
  }
  /* 兜底时钟：A3 登记它的 dispose —— 「停止」走 stopActiveRequest（不经过 finish），
     不登记的话 300s 定时器留着，到点把已停的那轮标成 error。 */
  const watchdog = createTurnWatchdog({
    silenceMs: opts.turnSilenceMs ?? TURN_TIMEOUT_MS,
    onStall: onTurnTimeout,
  })
  registerTurnWatchdog(threadId, () => watchdog.dispose())

  /* 续跑（重新生成/接着做）时把已有时间线也带上 —— 否则老片段会被丢掉 */
  const rounds = [...(placeholder.rounds ?? [])]
  const streamState: StreamState = {
    content,
    reasoning,
    toolRuns,
    rounds,
    citations,
    patch,
    threadId,
    /* 重试起点：按下发送那一刻（后面每个 turn_start 会重记，见 streamEvents） */
    retryMarks: markRoundStart(content, reasoning, rounds),
    snapshot: () => ({ ...placeholder, content, reasoning, toolRuns, citations, rounds }),
    finish: () => {
      finish()
      /* AG-001：不自己算 success/error/cancelled（主进程已推终态）；这里只管「要不要跑后置任务」 */
      if (lastEventType === 'done' || lastEventType === '') void runPostTurnTasks(threadId)
    },
  }

  off = subscribeChatEvents((event) => {
    if (event.requestId !== requestId) return
    /* 有事件就是「还活着」—— 这一行就是新旧兜底的全部区别（判定见 turnWatchdog.ts） */
    watchdog.touch()
    lastEventType = String(event.type ?? '')
    /* content / reasoning 是累积的，事件本身不带全量，所以状态得跟着更新 */
    const result = handleStreamEvent(event as Record<string, unknown>, streamState)
    if (result.handled) {
      content = streamState.content
      reasoning = streamState.reasoning
      /* 每来一段就看看该不该落盘（判断本身很便宜，不满足就直接返回） */
      persistence.flushPartial()
    }
  })

  try {
    /* 拿一次就够了 —— 这段以前把同一个 find 重复调了四次 */
    const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
    const result = await sendChat(
      buildSendPayload({
        requestId,
        resumeTaskId,
        requestTime,
        mode,
        messages: history,
        sessionId: threadId,
        ...(thread?.model ? { model: thread.model } : {}),
        projectId: thread?.projectId,
        temporary: Boolean(thread?.temporary),
        threadSettings: { ...thread?.settings, reasoning: thread?.reasoning },
        ...(thread?.workdir ? { workdir: thread.workdir } : {}),
        ...(thread?.collab ? { collab: thread.collab } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.regeneratedFrom
          ? {
              regeneratedFrom: opts.regeneratedFrom,
              regenerateIsLast: opts.regenerateIsLast === true,
            }
          : {}),
      }),
    )
    if (!result.ok) throw new Error(result.error ?? '发送失败')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patch({ status: 'error', kind: 'error', errorText: message, content: message })
    useAppStore.getState().setThreadStatus(threadId, 'error')
    ui.showToast('error', '发送失败', message)
    /* A1：这条没走任何事件路径，收尾的 reason 得显式给 —— 否则相位停在半路 */
    finishReason = 'error'
    finish()
  }
  /* 成功时不在这里收尾 —— 等 done / aborted / error 事件 */
}
