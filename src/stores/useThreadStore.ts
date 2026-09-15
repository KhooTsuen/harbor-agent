import { create } from 'zustand'
import type { Message, Thread } from '@/types'
import { MAX_INPUT_LENGTH, MODES } from '@/constants'
import { deriveTitle } from '@/lib/mock'
import { uid } from '@/lib/utils'
import { useRealBackend } from '@/lib/backend'
import { runElectronTurn, stopActiveRequest } from './thread/turns'
import { createSession } from '@/lib/backend'
import { adviseCompact, runCompact } from './thread/compact'
import { runMockTurn } from './thread/mockTurn'
import { getActiveThread, useAppStore } from './useAppStore'
import { useUIStore } from './useUIStore'
import { useConfigStore } from './useConfigStore'

/* ══════════════════════════════════════════════════════════════
   当前线程的输入与生成

   **两条路径：**
     · Electron → 真流式（agent 循环、工具调用、写操作确认）
     · 浏览器预览 → 静态回复

   两条路产出的 Message 形状一样，UI 不用关心走的哪条。
   ══════════════════════════════════════════════════════════════ */

interface ThreadState {
  input: string
  sending: boolean
  /** 待发送的图片（data URL）。发出去后清空 */
  inputImages: string[]
  addInputImage: (dataUrl: string) => void
  removeInputImage: (index: number) => void
  clearInputImages: () => void
  /** 当前会话的「建议回复」（一轮结束后生成，点一下填进输入框） */
  suggestions: string[]
  setSuggestions: (threadId: string, list: string[]) => void
  streamingMessageId: string | null

  setInput: (value: string) => void
  clearInput: () => void
  sendMessage: (override?: string) => void
  stopGeneration: () => void
  regenerateMessage: (messageId: string) => void
  continueThread: () => void
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  input: '',
  sending: false,
  inputImages: [],
  suggestions: [],
  streamingMessageId: null,

  setInput: (value) => set({ input: value.slice(0, MAX_INPUT_LENGTH) }),
  clearInput: () => set({ input: '' }),

  sendMessage: (override) => {
    const raw = (override ?? get().input).trim()
    if (get().sending) return
    /* 只有图片、没有文字也算有效输入 */
    if (!raw && get().inputImages.length === 0) return

    const app = useAppStore.getState()
    const ui = useUIStore.getState()

    /* /compact：手动压缩，不发给模型 */
    if (raw === '/compact') {
      get().clearInput()
      get().clearInputImages()
      const current = getActiveThread(app)
      if (current) void runCompact(current.id)
      return
    }
    if (raw === '/temporary') {
      get().clearInput()
      const current = getActiveThread(app)
      if (current) {
        useAppStore.setState((s) => ({
          threads: s.threads.map((t) => (t.id === current.id ? { ...t, temporary: true } : t)),
        }))
        ui.showToast('info', '临时对话', '本次对话不会写入长期记忆')
      }
      return
    }
    if (raw === '/new') {
      get().clearInput()
      app.createThread()
      return
    }
    if (raw === '/clear') {
      get().clearInput()
      const current = getActiveThread(app)
      if (current) app.clearMessages(current.id)
      return
    }
    if (raw === '/readonly' || raw === '/agent' || raw === '/research') {
      get().clearInput()
      const current = getActiveThread(app)
      const next =
        raw.slice(1) === 'readonly' ? 'plan' : raw.slice(1) === 'research' ? 'plan' : 'execute'
      if (current) app.setThreadMode(current.id, next)
      return
    }
    /*
     * 没有对话就新建一条。
     *
     * **不需要先有「文件夹」** —— 单独对话（workdir 为空）用的是默认工作目录，
     * 照样能聊。以前这里要求必须有项目，于是单独对话一发消息就被拦下，
     * 弹「找不到项目 / 这个线程关联的项目已被删除」：那个 project 变量
     * 取出来检查完就再没用过，纯粹是改造前留下的挡路检查。
     */
    let thread = getActiveThread(app)
    if (!thread) {
      const id = app.createThread()
      thread = useAppStore.getState().threads.find((t) => t.id === id)
      if (!thread) return
    }

    const threadId = thread.id
    const wasUntitled = thread.title === '新对话'

    /* 新建线程先用 pending id 占位；第一次发送前再真正创建磁盘会话。 */
    if (useRealBackend && threadId.startsWith('pending_')) {
      void (async () => {
        const meta = await createSession({
          title: '新对话',
          mode: thread.mode,
          model: thread.model,
          /* 单独对话要显式传 ''，否则主进程会把它塞进全局工作目录那个文件夹 */
          workdir: thread.workdir ?? '',
          threadSettings: thread.settings ? { ...thread.settings } : undefined,
        })
        if (!meta) {
          ui.showToast('error', '创建会话失败', '无法在 data/sessions 中创建会话文件')
          return
        }
        useAppStore.getState().replaceThreadId(threadId, meta.id)
        useThreadStore.getState().sendMessage(raw)
      })()
      return
    }

    /* 上下文检查：超提示线就提醒，超自动线就后台压（不阻塞这次发送） */
    const maxTokens = useConfigStore.getState().config?.assistant.maxTokens ?? 4096
    const advice = adviseCompact(thread.messages, maxTokens)
    if (advice.auto) {
      void runCompact(threadId, true)
    } else if (advice.warn) {
      ui.showToast('info', '上下文偏长', '输入 /compact 可以压缩一下')
    }

    /* 用户消息 —— 两条路径都要 */
    const images = get().inputImages
    const userMessage: Message = {
      id: uid('msg'),
      threadId,
      role: 'user',
      content: raw,
      kind: 'text',
      status: 'sent',
      timestamp: Date.now(),
      /* 图片跟着这条消息走：显示、以及发给模型时都要用 */
      ...(images.length > 0 ? { images } : {}),
    }
    useAppStore.getState().addMessage(threadId, userMessage)
    useAppStore.getState().persistMessage(threadId, {
      role: 'user',
      content: raw || '（图片）',
      ts: userMessage.timestamp,
    })
    get().clearInput()

    if (wasUntitled) {
      /* 先用第一句话占个位（titleAuto = true），之后模型起了更好的会覆盖。
         只有图片时没有文字可截，起个占位名，等模型起了再换。 */
      useAppStore.getState().autoTitle(threadId, deriveTitle(raw) || '看图')
    }

    if (useRealBackend) {
      void runElectronTurn(threadId, raw, set)
    } else {
      void runMockTurn(threadId, raw, set)
    }
  },

  addInputImage: (dataUrl) =>
    /* 最多 5 张：再多上下文也塞不下，而且多半是误操作 */
    set((s) => (s.inputImages.length >= 5 ? s : { inputImages: [...s.inputImages, dataUrl] })),

  removeInputImage: (index) =>
    set((s) => ({ inputImages: s.inputImages.filter((_, i) => i !== index) })),

  clearInputImages: () => set({ inputImages: [] }),

  setSuggestions: (threadId, list) => {
    /* 只记当前会话的 —— 切走就作废，免得显示上一个会话的建议 */
    const active = useAppStore.getState().activeThreadId
    set({ suggestions: active === threadId ? list : [] })
  },

  stopGeneration: () => {
    stopActiveRequest()
    set({ sending: false })
  },

  continueThread: () => {
    const current = getActiveThread(useAppStore.getState())
    if (current) get().sendMessage('继续刚才的任务，直接从当前状态往下做。')
  },

  regenerateMessage: (messageId) => {
    const app = useAppStore.getState()
    const thread = getActiveThread(app)
    if (!thread) return

    const index = thread.messages.findIndex((m) => m.id === messageId)
    if (index < 0) return

    let userText = ''
    for (let i = index - 1; i >= 0; i -= 1) {
      const m = thread.messages[i]
      if (m && m.role === 'user') {
        userText = m.content
        break
      }
    }
    if (!userText) return

    for (const m of thread.messages.slice(index)) {
      useAppStore.getState().removeMessage(thread.id, m.id)
    }
    get().sendMessage(userText)
  },
}))

/** 当前模式的元信息，供 UI 直接用 */
export function useActiveMode(): Thread['mode'] {
  const threadId = useAppStore((s) => s.activeThreadId)
  const thread = useAppStore((s) => s.threads.find((t) => t.id === threadId))
  return thread?.mode ?? MODES[1].id
}
