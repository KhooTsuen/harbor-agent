import { create } from 'zustand'
import type { Message, Thread } from '@/types'
import { MAX_INPUT_LENGTH, MODES } from '@/constants'
import { deriveTitle } from '@/lib/mock'
import { uid } from '@/lib/utils'
import { useRealBackend } from '@/lib/backend'
import { pauseActiveRequest, runElectronTurn, stopActiveRequest } from './thread/turns'
import { createSession } from '@/lib/backend'
import { adviseCompact, modelWindowOf, runCompact } from './thread/compact'
import { tryHandleCommand } from './thread/commands'
import { runMockTurn } from './thread/mockTurn'
import { makeVersionActions } from './thread/messageVersions'
import { attachBlock, makeAttachmentActions, type AttachmentSlice } from './thread/attachments'
import { prepareOutgoing } from './thread/outgoing'
import { questionTargetOf } from '@/lib/answers'
import { userRecord } from './thread/userRecord'
import { getActiveThread, useAppStore } from './useAppStore'
import { useUIStore } from './useUIStore'
import { useConfigStore } from './useConfigStore'
import type { MessageAttachments, QueueEntry } from './thread/messageDraft'
import { replaceDraftOwner } from './thread/draftOwner'
import { migratePendingDraft } from './thread/pendingDraft'
import { makeSendImmediately } from './thread/sendImmediately'

export interface ThreadState extends AttachmentSlice {
  input: string
  /** 正在跑的对话 id（按对话记，后端每个请求独立，别的对话不拦） */
  sendingThreads: string[]
  suggestions: string[]
  setSuggestions: (threadId: string, list: string[]) => void

  queuedMessages: Record<string, QueueEntry[]>
  enqueueMessage: (threadId: string, text: QueueEntry) => void
  removeQueuedMessage: (threadId: string, index: number) => void

  drafts: Record<string, string>
  attachmentDrafts: Record<string, MessageAttachments>
  /** 切换线程时调：把当前 input 存进旧线程的草稿，再把新线程的草稿恢复到 input */
  switchDraft: (fromId: string | null, toId: string) => void

  setInput: (value: string) => void
  clearInput: () => void
  sendMessage: (
    override?: string,
    resumeTaskId?: string,
    targetThreadId?: string,
    attachments?: MessageAttachments,
  ) => void
  stopGeneration: () => void
  sendImmediately: () => Promise<boolean>
  pauseGeneration: () => void
  resumeTask: (taskId: string) => void
  regenerateMessage: (messageId: string) => void
  editAndRerun: (threadId: string, messageId: string, text: string) => void
  /** 切到某一版重新回答（界面上 ‹ n / N ›） */
  activateUserVersion: (threadId: string, messageId: string, index: number) => void
  /** 补一版回答：给没回答过的那一版提问跑一轮（提示按钮调的，点了才跑） */
  answerVersion: (
    threadId: string,
    text: string,
    versions: string[] | undefined,
    index: number,
  ) => void
  /** 切到这条提问的第几条回答（回答下面的 ‹ n / N ›）—— 不重跑 */
  activateAnswer: (threadId: string, messageId: string, index: number) => void
  continueThread: () => void
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  input: '',
  sendingThreads: [],
  ...makeAttachmentActions(set),
  suggestions: [],
  queuedMessages: {},
  drafts: {},
  attachmentDrafts: {},
  switchDraft: (fromId, toId) =>
    set((s) => {
      const drafts = { ...s.drafts }
      const attachmentDrafts = { ...s.attachmentDrafts }
      if (fromId) drafts[fromId] = s.input
      if (fromId) attachmentDrafts[fromId] = { images: s.inputImages, files: s.inputFiles }
      const saved = attachmentDrafts[toId]
      return {
        drafts,
        attachmentDrafts,
        input: drafts[toId] ?? '',
        inputImages: saved?.images ?? [],
        inputFiles: saved?.files ?? [],
      }
    }),

  enqueueMessage: (threadId, text) =>
    set((s) => {
      const list = s.queuedMessages[threadId] ?? []
      return { queuedMessages: { ...s.queuedMessages, [threadId]: [...list, text] } }
    }),

  removeQueuedMessage: (threadId, index) =>
    set((s) => {
      const list = s.queuedMessages[threadId]
      if (!list) return {}
      const next = list.filter((_, i) => i !== index)
      const queuedMessages = { ...s.queuedMessages }
      if (next.length) queuedMessages[threadId] = next
      else delete queuedMessages[threadId]
      useUIStore.getState().showToast('info', '已移出队列')
      return { queuedMessages }
    }),

  setInput: (value) => set({ input: value.slice(0, MAX_INPUT_LENGTH) }),
  clearInput: () => set({ input: '' }),

  sendMessage: (override, resumeTaskId, targetThreadId, attachments) => {
    const outgoing = prepareOutgoing({
      text: override ?? get().input,
      attachments,
      draftFiles: get().inputFiles,
      draftImages: get().inputImages,
    })
    if (!outgoing) return
    const { raw, files, images } = outgoing

    const app = useAppStore.getState()
    const ui = useUIStore.getState()

    if (!targetThreadId && tryHandleCommand(raw)) return

    /* 指定目标不存在时不退回当前对话。 */
    let thread = targetThreadId
      ? app.threads.find((t) => t.id === targetThreadId)
      : getActiveThread(app)
    if (targetThreadId && !thread) return
    if (!thread) {
      const id = app.createThread()
      thread = useAppStore.getState().threads.find((t) => t.id === id)
      if (!thread) return
    }

    const threadId = thread.id
    const wasUntitled = thread.title === '新对话'

    /* 运行中的对话排队，保存完整附件。 */
    if (get().sendingThreads.includes(threadId)) {
      get().enqueueMessage(threadId, { text: raw, images: [...images], files: [...files] })
      if (!attachments) {
        get().clearInput()
        get().clearInputImages()
        get().clearInputFiles()
      }
      /* AG-032：措辞与文档的例子对齐（「已加入队列」）*/
      ui.showToast('info', '已加入队列', '当前任务完成后自动发送')
      return
    }

    /* 新建线程先用 pending id 占位；第一次发送前再真正创建磁盘会话。 */
    if (useRealBackend && threadId.startsWith('pending_')) {
      void (async () => {
        const meta = await createSession({
          title: '新对话',
          mode: thread.mode,
          model: thread.model,
          reasoning: thread.reasoning,
          /* 单独对话要显式传 ''，否则主进程会把它塞进全局工作目录那个文件夹 */
          workdir: thread.workdir ?? '',
          threadSettings: thread.settings ? { ...thread.settings } : undefined,
          collab: thread.collab,
        })
        if (!meta) {
          ui.showToast('error', '创建会话失败', '无法在 data/sessions 中创建会话文件')
          return
        }
        const current = get()
        set(
          migratePendingDraft(
            { ...current, images: current.inputImages, files: current.inputFiles },
            threadId,
            meta.id,
            { text: raw, images, files },
            useAppStore.getState().activeThreadId === threadId,
          ),
        )
        replaceDraftOwner(threadId, meta.id)
        useAppStore.getState().replaceThreadId(threadId, meta.id)
        useThreadStore.getState().sendMessage(raw, resumeTaskId, meta.id, { images, files })
      })()
      return
    }

    /* 上下文过长时提示或压缩。 */
    const cfg = useConfigStore.getState().config
    const maxTokens = cfg?.context?.baseTokens ?? 0
    const window = modelWindowOf(cfg?.capabilities, thread.model)
    const ratios = { warn: cfg?.context?.compactAt, auto: cfg?.context?.autoCompactAt }
    const advice = adviseCompact(thread.messages, maxTokens, ratios, window)
    if (advice.auto) {
      void runCompact(threadId, true)
    } else if (advice.warn) {
      ui.showToast('info', '上下文偏长', '输入 /compact 可以压缩一下')
    }

    const userMessage: Message = {
      id: uid('msg'),
      threadId,
      role: 'user',
      content: raw + attachBlock(files),
      kind: 'text',
      status: 'sent',
      timestamp: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    }
    useAppStore.getState().addMessage(threadId, userMessage)
    /* 保留消息所属的问答版本。 */
    const parent = questionTargetOf(thread?.messages ?? [])
    useAppStore.getState().persistMessage(threadId, userRecord(userMessage, parent))
    if (!attachments) get().clearInput()
    if (!attachments) {
      get().clearInputImages()
      get().clearInputFiles()
    }

    if (wasUntitled) {
      useAppStore.getState().autoTitle(threadId, deriveTitle(raw) || '看图')
    }

    if (useRealBackend) {
      void runElectronTurn(threadId, raw, set, resumeTaskId ?? '', {
        reason: resumeTaskId ? '点继续' : '用户发送',
      })
    } else {
      void runMockTurn(threadId, raw, set)
    }
  },

  pauseGeneration: () => {
    const current = getActiveThread(useAppStore.getState())
    if (!current) return
    /* 暂停会等当前步骤结束，先反馈给用户。 */
    useUIStore.getState().showToast('info', '正在暂停', '做完手上这一步就会停下来')
    pauseActiveRequest(current.id)
  },

  resumeTask: (taskId: string) => {
    /* 复用原任务继续执行。 */
    if (!taskId) return
    get().sendMessage('继续刚才的任务，从上次停下的地方接着做，别重复已经完成的步骤。', taskId)
  },

  setSuggestions: (threadId, list) => {
    /* 只记当前会话的 —— 切走就作废，免得显示上一个会话的建议 */
    const active = useAppStore.getState().activeThreadId
    set({ suggestions: active === threadId ? list : [] })
  },

  stopGeneration: () => {
    /* 只停当前这条 —— 别的对话在跑的不受影响 */
    const current = getActiveThread(useAppStore.getState())
    void stopActiveRequest(current?.id).then((stopped) => {
      if (!stopped) {
        useUIStore
          .getState()
          .showToast('error', '停止失败', '后台未确认取消；请重试，运行中的命令可能继续执行')
        return
      }
      if (current)
        useUIStore.getState().showToast('info', '正在停止', '等待当前步骤结束后再发送新消息')
    })
    /* 先告知停止请求已发出；后端确认后更新为「正在停止」，失败时显示失败原因。 */
    useUIStore.getState().showToast('info', '正在请求停止', '确认当前任务结束前，不会启动新的执行')
  },

  sendImmediately: makeSendImmediately(set, get),

  continueThread: () => {
    const current = getActiveThread(useAppStore.getState())
    if (current) get().sendMessage('继续刚才的任务，直接从当前状态往下做。')
  },

  ...makeVersionActions(set, get),
}))

/** 当前模式的元信息，供 UI 直接用 */
export function useActiveMode(): Thread['mode'] {
  const threadId = useAppStore((s) => s.activeThreadId)
  const thread = useAppStore((s) => s.threads.find((t) => t.id === threadId))
  return thread?.mode ?? MODES[1].id
}

/* 所有对话切换通过订阅同步草稿。 */
let lastDraftThread = useAppStore.getState().activeThreadId
useAppStore.subscribe((state) => {
  const current = state.activeThreadId
  if (current === lastDraftThread) return
  useThreadStore.getState().switchDraft(lastDraftThread, current)
  lastDraftThread = current
})
