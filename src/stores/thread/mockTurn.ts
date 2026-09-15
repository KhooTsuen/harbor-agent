import type { Message } from '@/types'
import { generateReplyStream } from '@/lib/mock'
import { uid } from '@/lib/utils'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import type { TurnSetter } from './turns'

/* ══════════════════════════════════════════════════════════════
   路径 B：浏览器 UI 预览回复

   仅在浏览器预览环境使用，桌面版不会进入这条路径。
   ══════════════════════════════════════════════════════════════ */

/** 模拟模式的中断句柄，由 stopActiveRequest 调用 */
let mockAbort: (() => void) | null = null

export function abortMockTurn(): void {
  if (mockAbort) mockAbort()
}

/* ══════════════════════════════════════════════════════════════
   路径 B：浏览器预览
   ══════════════════════════════════════════════════════════════ */

export async function runMockTurn(
  threadId: string,
  userText: string,
  set: TurnSetter,
): Promise<void> {
  const app = useAppStore.getState()
  const ui = useUIStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return

  const project = app.projects.find((p) => p.id === thread.projectId)
  if (!project) return

  const placeholder: Message = {
    id: uid('msg'),
    threadId,
    role: 'assistant',
    content: '',
    kind: 'text',
    status: 'streaming',
    timestamp: Date.now(),
  }
  app.addMessage(threadId, placeholder)
  app.setThreadStatus(threadId, 'running')

  const controller = new AbortController()
  set({ sending: true, streamingMessageId: placeholder.id })
  /* 浏览器预览也支持停止：直接把 signal 挂到 store 上 */
  mockAbort = () => controller.abort()

  try {
    const payload = await generateReplyStream(userText, thread, project, {
      signal: controller.signal,
      speed: 1,
      onChunk: (accumulated) => {
        useAppStore.getState().updateMessage(threadId, placeholder.id, { content: accumulated })
      },
    })

    useAppStore.getState().updateMessage(threadId, placeholder.id, {
      content: payload.content,
      kind: payload.kind,
      status: 'sent',
      ...(payload.codeBlocks ? { codeBlocks: payload.codeBlocks } : {}),
      ...(payload.diffs ? { diffs: payload.diffs } : {}),
      ...(payload.terminalLines ? { terminalLines: payload.terminalLines } : {}),
    })
    useAppStore.getState().setThreadStatus(threadId, 'success')
    useAppStore.getState().persistMessage(threadId, {
      role: 'assistant',
      content: payload.content,
      ts: Date.now(),
    })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    const text = error instanceof Error ? error.message : '未知错误'
    if (aborted) {
      useAppStore.getState().updateMessage(threadId, placeholder.id, {
        content: '（已停止）',
        status: 'sent',
      })
      useAppStore.getState().setThreadStatus(threadId, 'idle')
    } else {
      useAppStore.getState().updateMessage(threadId, placeholder.id, {
        status: 'error',
        kind: 'error',
        errorText: text,
        content: text,
      })
      useAppStore.getState().setThreadStatus(threadId, 'error')
      ui.showToast('error', '生成失败', text)
    }
  } finally {
    mockAbort = null
    set({ sending: false, streamingMessageId: null })
  }
}
