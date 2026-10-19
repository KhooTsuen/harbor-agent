import type { ThreadState } from '../useThreadStore'
import type { MessageAttachments } from './messageDraft'
import { stopActiveRequest, waitForTurnEnd } from './turns'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'

type Get = () => ThreadState
type Set = (update: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void
const inFlight = new Set<string>()

export function makeSendImmediately(set: Set, get: Get): () => Promise<boolean> {
  return async () => {
    const thread = useAppStore
      .getState()
      .threads.find((item) => item.id === useAppStore.getState().activeThreadId)
    const draft = get()
    const text = draft.input
    const images = draft.inputImages
    const files = draft.inputFiles
    if (
      !thread ||
      (!text.trim() && images.length === 0 && files.length === 0) ||
      inFlight.has(thread.id)
    )
      return false
    inFlight.add(thread.id)
    try {
      if (!(await stopActiveRequest(thread.id))) {
        useUIStore
          .getState()
          .showToast('error', '没有发送', '当前任务尚未确认停止；消息仍保留在输入框中')
        return false
      }
      if (!(await waitForTurnEnd(thread.id))) {
        useUIStore
          .getState()
          .showToast('error', '仍在停止', '旧任务还未结束；消息保留在输入框，可稍后重试')
        return false
      }
      if (!useAppStore.getState().threads.some((item) => item.id === thread.id)) return false
      const attachments: MessageAttachments = { images: [...images], files: [...files] }
      const before = new Set(thread.messages.map((message) => message.id))
      get().sendMessage(text, undefined, thread.id, attachments)
      const sent = useAppStore
        .getState()
        .threads.find((item) => item.id === thread.id)
        ?.messages.some((message) => message.role === 'user' && !before.has(message.id))
      if (!sent) return false
      set((state) => {
        if (useAppStore.getState().activeThreadId === thread.id)
          return state.input === text && state.inputImages === images && state.inputFiles === files
            ? { input: '', inputImages: [], inputFiles: [] }
            : {}
        const saved = state.attachmentDrafts[thread.id]
        if (state.drafts[thread.id] !== text || saved?.images !== images || saved?.files !== files)
          return {}
        return {
          drafts: { ...state.drafts, [thread.id]: '' },
          attachmentDrafts: { ...state.attachmentDrafts, [thread.id]: { images: [], files: [] } },
        }
      })
      useUIStore.getState().showToast('info', '已停止当前任务并发送', '原有排队消息仍保留')
      return true
    } finally {
      inFlight.delete(thread.id)
    }
  }
}
