import type { Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { abortChat, sendChat, subscribeChatEvents } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
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

/** 正在进行的真实请求（用于中断） */
let activeRequestId: string | null = null
export function stopActiveRequest(): void {
  if (activeRequestId) {
    void abortChat(activeRequestId)
    activeRequestId = null
  }
  abortMockTurn()
}

export interface TurnSetter {
  (partial: { sending?: boolean; streamingMessageId?: string | null }): void
}

/* ══════════════════════════════════════════════════════════════
   路径 A：真实后端（Electron）
   ══════════════════════════════════════════════════════════════ */

export async function runElectronTurn(
  threadId: string,
  _userText: string,
  set: TurnSetter,
): Promise<void> {
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
  app.setThreadStatus(threadId, 'running')

  const requestId = uid('req')
  activeRequestId = requestId
  set({ sending: true, streamingMessageId: placeholder.id })

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
  const finish = (): void => {
    if (finished) return
    finished = true
    window.clearTimeout(timeoutId)
    off()
    activeRequestId = null
    set({ sending: false, streamingMessageId: null })
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
      /* 状态由事件类型决定：done 成功、error 失败、aborted 取消 */
      const map: Record<string, 'success' | 'error' | 'cancelled'> = {
        done: 'success',
        error: 'error',
        aborted: 'cancelled',
      }
      const next = map[lastEventType] ?? 'success'
      useAppStore.getState().setThreadStatus(threadId, next)
      /*
       * 成功才跑后置任务（起标题、生成建议回复）——
       * 失败/取消的对话没必要再花一次模型调用。
       */
      if (next === 'success') void runPostTurnTasks(threadId)
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
