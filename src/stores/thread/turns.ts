import type { Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { abortChat, pauseChat, sendChat, subscribeChatEvents } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { useThreadStore } from '../useThreadStore'
import { abortMockTurn } from './mockTurn'
import { runPostTurnTasks } from './sceneTasks'
import { handleStreamEvent, type StreamState } from './streamEvents'

/* ══════════════════════════════════════════════════════════════
   一轮对话的两条实现路径

   **Electron** → 真流式：agent 循环、工具调用、写操作确认
   **浏览器预览** → 静态回复

   两条路产出的 Message 形状一样，UI 不用关心走的哪条。
   这个文件只负责「怎么产生回复」，不负责 store —— 所以写成纯函数，
   由 useThreadStore 调用。
   ══════════════════════════════════════════════════════════════ */

/**
 * 正在进行的真实请求，**按对话存**。
 *
 * 以前是一个 `activeRequestId: string | null` —— 并行跑两条对话时，
 * 第二条会把第一条的 id 覆盖掉，于是「停止」永远只能停最后开始的那条。
 */
const activeRequests = new Map<string, string>()

/**
 * AG-025：一条对话跑完之后，自动发出排队的下一条。
 *
 * 放在 finish() 里调用 —— finish 是「消息结束」的统一出口（done / 超时 /
 * 发送失败都走它），所以排队消息不管上一轮怎么结束的，都会接着发。
 *
 * 不 await：sendMessage 会同步启动新的 runTurn，剩下的交给新一轮自己的事件流。
 */
function drainQueued(threadId: string): void {
  const { queuedMessages, removeQueuedMessage, sendMessage } = useThreadStore.getState()
  const list = queuedMessages[threadId]
  if (!list || list.length === 0) return
  const next = list[0]
  removeQueuedMessage(threadId, 0)
  sendMessage(next)
}

/** 传 threadId 只停那一条；不传就把所有在跑的都停掉 */
export function stopActiveRequest(threadId?: string): void {
  if (threadId) {
    const id = activeRequests.get(threadId)
    if (id) void abortChat(id)
    activeRequests.delete(threadId)
  } else {
    for (const id of activeRequests.values()) void abortChat(id)
    activeRequests.clear()
  }
  abortMockTurn()
}

/**
 * 暂停（AG-011）：给主进程发个「安全点停住」的请求。
 *
 * ★ 和 stop 的关键区别：**不删 activeRequests** —— 请求还在跑，
 *   只是它会做完手上这一步就自己收尾（界面会收到 agent.paused）。
 *   删了的话用户就没法再暂停/停止它了。
 */
export function pauseActiveRequest(threadId?: string): void {
  if (threadId) {
    const id = activeRequests.get(threadId)
    if (id) void pauseChat(id)
    return
  }
  for (const id of activeRequests.values()) void pauseChat(id)
}

/** 按对话记的「正在跑」—— 对应 useThreadStore.sendingThreads */
export interface ThreadPartial {
  sendingThreads?: string[]
}

export interface TurnSetter {
  (partial: ThreadPartial | ((state: { sendingThreads: string[] }) => ThreadPartial)): void
}

/* ══════════════════════════════════════════════════════════════
   路径 A：真实后端（Electron）
   ══════════════════════════════════════════════════════════════ */

export async function runElectronTurn(
  threadId: string,
  _userText: string,
  set: TurnSetter,
  /* AG-011：带这个就是「接着上次那条任务做」——主进程会复用原任务 */
  resumeTaskId = '',
): Promise<void> {
  /* AG-003：用户按下发送的时刻 —— 主进程的 TTFT 等等都是从这一刻开始算的 */
  const requestTime = Date.now()

  const app = useAppStore.getState()
  const ui = useUIStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return
  const mode = thread.mode

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
  }
  app.addMessage(threadId, placeholder)
  /*
   * AG-001：这里以前是 setThreadStatus(threadId, 'running') —— 渲染层自己宣布
   * 「在跑了」。现在状态由主进程的状态机推（preparing/thinking/executing…），
   * 前端只收 phase 事件。UI 与后台不一致的根源就在这一行。
   */

  const requestId = uid('req')
  activeRequests.set(threadId, requestId)
  set((s) => ({ sendingThreads: [...new Set([...s.sendingThreads, threadId])] }))

  /** 工具调用累积（id -> record） */
  const toolRuns: ToolRunRecord[] = []
  const citations: Message['citations'] = []
  let reasoning = ''
  let content = ''

  const patch = (fields: Partial<Message>): void => {
    useAppStore.getState().updateMessage(threadId, placeholder.id, fields)
  }

  /* 历史消息喂给主进程（system 由主进程自己拼，不重复发） */
  const history =
    useAppStore
      .getState()
      .threads.find((t) => t.id === threadId)
      ?.messages.filter((m) => m.id !== placeholder.id && m.role !== 'system')
      .map((m) => {
        /* 带图的消息换多模态格式 —— 漏了这步模型只会收到文字，然后说「没收到图片」 */
        if (m.role === 'user' && m.images && m.images.length > 0) {
          return {
            role: m.role,
            content: [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...m.images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
            ],
          }
        }
        return {
          role: m.role,
          content:
            m.role === 'assistant' && m.toolRuns?.length
              ? `${m.content}\n\n[此前工具执行记录]\n${m.toolRuns
                  .map(
                    (tool) =>
                      `- ${tool.name}: ${tool.ok ? '成功' : '失败'}${tool.output ? `\n  ${tool.output.slice(0, 2000)}` : ''}`,
                  )
                  .join('\n')}`
              : m.content,
        }
      }) ?? []

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
   * 助手回复落盘。
   *
   * 以前只落用户消息，助手那条**一次都没写** —— 磁盘上的会话文件永远只有
   * meta + user，重启后助手说过的话全没了。（读的那一侧早就支持 assistant，
   * 连 toolRuns / citations / usage 都解析好了，是写这一侧漏了。）
   *
   * 存的是**收尾后状态里的那条消息**，不是闭包里那几个变量：usage 只在状态里，
   * toolRuns 在流式过程中被复制过几份，读它更稳。
   * aborted 也存 —— 那是用户自己按停的，半截回复也是结果；error 不存，
   * 把报错当历史喂回模型没有意义。
   */
  const persistReply = (): void => {
    if (lastEventType !== 'done' && lastEventType !== 'aborted') return
    const final = useAppStore
      .getState()
      .threads.find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === placeholder.id)
    if (!final) return
    const text = final.content ?? ''
    /* 空回复（比如刚发出去就被停掉）不写 —— 免得会话里多一条空消息 */
    if (!text.trim() && (final.toolRuns ?? []).length === 0) return
    useAppStore.getState().persistMessage(threadId, {
      role: 'assistant',
      content: text,
      ...(final.reasoning ? { reasoning: final.reasoning } : {}),
      ...(final.toolRuns?.length ? { toolRuns: final.toolRuns } : {}),
      ...(final.citations?.length ? { citations: final.citations } : {}),
      ...(final.usage ? { usage: final.usage } : {}),
      ts: final.timestamp,
    })
  }

  const finish = (): void => {
    if (finished) return
    finished = true
    persistReply()
    window.clearTimeout(timeoutId)
    off()
    activeRequests.delete(threadId)
    set((s) => ({ sendingThreads: s.sendingThreads.filter((id) => id !== threadId) }))
    /* AG-025：这条跑完了，自动发排队的下一条 */
    drainQueued(threadId)
  }

  /* 兜底：万一结束事件因故没到，也不能让界面一直转 */
  const timeoutId = window.setTimeout(
    () => {
      patch({ status: 'sent', content: content || '（超时未结束）' })
      useAppStore.getState().setThreadStatus(threadId, 'error')
      finish()
    },
    5 * 60 * 1000,
  )

  const streamState: StreamState = {
    content,
    reasoning,
    toolRuns,
    citations,
    patch,
    threadId,
    snapshot: () => ({ ...placeholder, content, reasoning, toolRuns, citations }),
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
      mode,
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
