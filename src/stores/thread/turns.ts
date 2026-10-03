import type { Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { sendChat, subscribeChatEvents } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { usePerfStore } from '../usePerfStore'
import { runPostTurnTasks } from './sceneTasks'
import { handleStreamEvent, type StreamState } from './streamEvents'
import { buildHistory } from './history'
import { guardSendableImages } from './sendGuard'
import { beginTurnRequest, drainQueued, endTurnRequest, type TurnSetter } from './turnControl'
import { createReplyPersistence } from './replyPersistence'
import { drainPendingRegen } from './regenQueue'
import { questionTargetOf, existingAnswersAfter } from '@/lib/answers'
import type { StoredMessage } from '@/types/models-extra'
import { logError } from '@/lib/actionLog'

/* ══════════════════════════════════════════════════════════════
   一轮对话的两条实现路径

   **Electron** → 真流式：agent 循环、工具调用、写操作确认
   **浏览器预览** → 静态回复

   两条路产出的 Message 形状一样，UI 不用关心走的哪条。
   这个文件只负责「怎么产生回复」，不负责 store —— 所以写成纯函数，
   由 useThreadStore 调用。
   ══════════════════════════════════════════════════════════════ */

/*
 * 「在跑的那几个请求」（登记 / 停止 / 暂停 / 跑完接着发排队）搬到了 turnControl.ts ——
 * 那边自成一体，而这个文件贴着 300 行红线。这里**原样再导出**，
 * 外部（useThreadStore / regenerate / 各测试）的导入路径不用改。
 */
export {
  drainQueued,
  pauseActiveRequest,
  stopActiveRequest,
  type ThreadPartial,
  type TurnSetter,
} from './turnControl'

/* ══════════════════════════════════════════════════════════════
   路径 A：真实后端（Electron）
   ══════════════════════════════════════════════════════════════ */

/**
 * 一轮最多跑这么久；到点就收尾（兜底的超时，不是业务上限制）。
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
     * 这一版**原来那条回答**（编辑 / 重新生成时，界面上刚被换掉的那条）。
     *
     * ★ 必须由调用方传：这些路会先 `removeMessagesAfter` 把它从消息列表里去掉，
     *   等这里再去「提问后面找已有回答」就找不到了 —— 于是旧回答只剩磁盘上有，
     *   要重开会话才切得回去（真机上就是这么发现的：编辑完「回答切换器」消失了）。
     */
    seedAnswers?: StoredMessage[]
    /** 这一轮是怎么起来的（只进日志）：用户发送 / 点继续 / 编辑后重答 / 重新生成 / 重试 */
    reason?: string
    /** 「重新生成」的关联：被替代那条的磁盘 key —— 落盘记 regeneratedFrom，发给主进程挂台账 */
    regeneratedFrom?: string
    /** 重新生成的是不是最后一轮（只有它是，旧台账 / 旧事务才一定属于它） */
    regenerateIsLast?: boolean
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

  /*
   * 这一轮回答的是谁、以及这条提问**已经有的回答**。
   *
   * ★ 必须在 addMessage（占位消息）**之前**取：占位消息一加进去，
   *   「这条提问下面已经有的回答」就变成它自己了 —— 重新生成时旧回答就丢了
   *   （磁盘上有、内存里没有，得等重开会话才切得回去）。
   */
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
  /*
   * AG-001：这里以前是 setThreadStatus(threadId, 'running') —— 渲染层自己宣布
   * 「在跑了」。现在状态由主进程的状态机推（preparing/thinking/executing…），
   * 前端只收 phase 事件。UI 与后台不一致的根源就在这一行。
   */

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
  /*
   * ★ 发送前**最后一道**：把要发出去的图全部归整一遍（规则与来由见 sendGuard.ts）。
   *   只在「贴进来那一刻」洗不够 —— 历史里的旧图会跟着每条新消息一起发出去，
   *   而旧会话里可能有当时没洗过的超大图（用户 2026-09-28：14200×7104 的旧 JPEG
   *   → 上游 400 `messages[10].image[0]: unsupported image`，看上去像「格式没修好」）。
   */
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

  /**
   * 收尾。**只在收到结束事件时调用**。
   *
   * 踩过的坑：以前写在 sendChat 后面的 finally 里 —— 但 sendChat 是主进程
   * 立刻返回的（agent 循环在后台跑），所以订阅刚建立就被取消了，done 事件
   * 全丢，界面永远停在「正在处理」。
   */
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

  const finish = (): void => {
    if (finished) return
    finished = true
    /*
     * ★ 先把「正在跑」摘掉，**再**落盘：2026-10-04 真机事故里这一步抛异常，界面就永远停在
     *   「运行中」，而落盘正是最先抛的那个（读不了盘 / 写会话失败都会抛）。
     *   同形状的兜底见 `streamEvents.ts` 的 `runSafely` 与下面的 `onTurnTimeout`。
     */
    set((s) => ({ sendingThreads: s.sendingThreads.filter((id) => id !== threadId) }))
    window.clearTimeout(timeoutId)
    off()
    endTurnRequest(threadId)
    try {
      persistence.persistReply()
    } catch (error) {
      logError('turn.persistReply', error)
    }
    drainPendingRegen(threadId)
    /* AG-025：这条跑完了，自动发排队的下一条 */
    drainQueued(threadId)
  }

  /*
   * 兜底：结束事件因故没到也不能一直转。★ 它也栽过 —— 以前第一句是 `patch(...)`，一句抛了
   * 后面的 `finish()` 也不跑（当晚两道保险死在同一形状上）。现在：先放开界面，再写状态。
   */
  const onTurnTimeout = (): void => {
    finish()
    try {
      patch({ status: 'sent', content: content || '（超时未结束）' })
      useAppStore.getState().setThreadStatus(threadId, 'error')
    } catch (error) {
      logError('turn.timeout', error)
    }
  }
  const timeoutId = window.setTimeout(onTurnTimeout, TURN_TIMEOUT_MS)

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
    snapshot: () => ({ ...placeholder, content, reasoning, toolRuns, citations, rounds }),
    finish: () => {
      finish()
      /*
       * AG-001：不再自己算 success/error/cancelled —— 主进程已经推了
       * completed / failed / cancelled，渲染层只读 phase。
       * 这里只需要知道「要不要跑后置任务」。
       */
      if (lastEventType === 'done' || lastEventType === '') void runPostTurnTasks(threadId)
    },
  }

  off = subscribeChatEvents((event) => {
    if (event.requestId !== requestId) return
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
    const result = await sendChat({
      requestId,
      resumeTaskId,
      /* AG-003：让主进程能用真正的「按下发送」时刻算延迟 */
      requestTime,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.regeneratedFrom
        ? { regenerateOf: opts.regeneratedFrom, regenerateIsLast: opts.regenerateIsLast === true }
        : {}),
      mode,
      /*
       * ★ 这条会话自己选的模型**必须发出去**（2026-09-28 用户报的 bug）：
       *   选择器只写了 thread.model（也落了会话 meta），而内核那边以前从不读它 ——
       *   于是「新建对话里选了 gpt，实际还是跑全局的 deepseek-flash」。
       *   空串/没选 = 交给内核用全局默认，保持原行为。
       */
      ...(thread?.model ? { model: thread.model } : {}),
      messages: history,
      sessionId: threadId,
      projectId: thread?.projectId,
      temporary: Boolean(thread?.temporary),
      /* 思考档位跟着 threadSettings 一起发 —— 以前漏了，档位从没到过主进程 */
      threadSettings: { ...thread?.settings, reasoning: thread?.reasoning },
      ...(thread?.workdir ? { workdir: thread.workdir } : {}),
    })
    if (!result.ok) throw new Error(result.error ?? '发送失败')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patch({ status: 'error', kind: 'error', errorText: message, content: message })
    useAppStore.getState().setThreadStatus(threadId, 'error')
    ui.showToast('error', '发送失败', message)
    finish()
  }
  /* 成功时不在这里收尾 —— 等 done / aborted / error 事件 */
}
