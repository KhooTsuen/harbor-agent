import { create } from 'zustand'
import type { Message, Thread } from '@/types'
import { MAX_INPUT_LENGTH, MODES } from '@/constants'
import { deriveTitle } from '@/lib/mock'
import { uid } from '@/lib/utils'
import { useRealBackend } from '@/lib/backend'
import { pauseActiveRequest, runElectronTurn, stopActiveRequest } from './thread/turns'
import { createSession } from '@/lib/backend'
import { adviseCompact, runCompact } from './thread/compact'
import { tryHandleCommand } from './thread/commands'
import { runMockTurn } from './thread/mockTurn'
import { getActiveThread, useAppStore } from './useAppStore'
import { useUIStore } from './useUIStore'
import { useConfigStore } from './useConfigStore'

/* ══════════════════════════════════════════════════════════════
   当前线程的输入与生成（Electron 真流式 / 浏览器预览静态回复，两条路产出一样）
   ══════════════════════════════════════════════════════════════ */

interface ThreadState {
  input: string
  /** 正在跑的对话 id（按对话记，后端每个请求独立，别的对话不拦） */
  sendingThreads: string[]
  /** 待发送的图片（data URL）。发出去后清空 */
  inputImages: string[]
  addInputImage: (dataUrl: string) => void
  removeInputImage: (index: number) => void
  clearInputImages: () => void
  /** 当前会话的「建议回复」（一轮结束后生成，点一下填进输入框） */
  suggestions: string[]
  setSuggestions: (threadId: string, list: string[]) => void

  /** AG-025：每条对话排队的消息（对话在跑时用户又发的），任务结束自动发第一条 */
  queuedMessages: Record<string, string[]>
  enqueueMessage: (threadId: string, text: string) => void
  removeQueuedMessage: (threadId: string, index: number) => void

  /** AG-026：每条对话的输入草稿（切换线程时保留，切回来还在） */
  drafts: Record<string, string>
  /** 切换线程时调：把当前 input 存进旧线程的草稿，再把新线程的草稿恢复到 input */
  switchDraft: (fromId: string | null, toId: string) => void

  setInput: (value: string) => void
  clearInput: () => void
  sendMessage: (override?: string, resumeTaskId?: string) => void
  stopGeneration: () => void
  /** AG-011：暂停 —— 做完手上这步就停，之后可以接着做（不是立刻断） */
  pauseGeneration: () => void
  /** AG-011：继续一条暂停的任务（复用原任务，不新建） */
  resumeTask: (taskId: string) => void
  regenerateMessage: (messageId: string) => void
  continueThread: () => void
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  input: '',
  sendingThreads: [],
  inputImages: [],
  suggestions: [],
  queuedMessages: {},
  drafts: {},

  switchDraft: (fromId, toId) =>
    set((s) => {
      const drafts = { ...s.drafts }
      if (fromId) drafts[fromId] = s.input
      return { drafts, input: drafts[toId] ?? '' }
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
      /* AG-032：删掉的那条肉眼看不出来（列表只是少了一项）→ 给句回执 */
      useUIStore.getState().showToast('info', '已移出队列')
      return { queuedMessages }
    }),

  setInput: (value) => set({ input: value.slice(0, MAX_INPUT_LENGTH) }),
  clearInput: () => set({ input: '' }),

  sendMessage: (override, resumeTaskId) => {
    const raw = (override ?? get().input).trim()
    /* 只有图片、没有文字也算有效输入 */
    if (!raw && get().inputImages.length === 0) return

    const app = useAppStore.getState()
    const ui = useUIStore.getState()

    /* 斜杠命令：/compact /temporary /new /clear /readonly…（抽到了 thread/commands.ts） */
    if (tryHandleCommand(raw)) return

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

    /* AG-025：这条对话在跑 → 排队。用 sendingThreads 判断（旧的 status==='running' 在 AG-001 后从不会设成 running，空转）。任务结束自动发第一条。 */
    if (get().sendingThreads.includes(threadId)) {
      get().enqueueMessage(threadId, raw)
      get().clearInput()
      get().clearInputImages()
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
          /* 思考强度档位随会话一起落盘，重启后才记得住 */
          reasoning: thread.reasoning,
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
      void runElectronTurn(threadId, raw, set, resumeTaskId ?? '')
    } else {
      void runMockTurn(threadId, raw, set)
    }
  },

  pauseGeneration: () => {
    /* 和 stop 一样只针对当前这条；但不删 activeRequests（请求还在跑，只是要收尾了） */
    const current = getActiveThread(useAppStore.getState())
    if (!current) return
    /*
     * AG-011：必须给**即时**反馈。
     * 暂停是「做完手上这步再停」—— 那一轮可能是模型流式 + 一条长命令，
     * 几十秒都正常。不给提示的话用户会以为按钮坏了（真机测过：30 秒没动静）。
     */
    useUIStore.getState().showToast('info', '正在暂停', '做完手上这一步就会停下来')
    pauseActiveRequest(current.id)
  },

  resumeTask: (taskId: string) => {
    /*
     * AG-011：把一条暂停的任务接着做。
     *
     * 走的是普通发送链路（就当成用户说了一句话）—— 这样历史、事件、
     * 生命周期全部照旧，不用另造一套。区别只在多带一个 resumeTaskId，
     * 主进程看到它就**复用原任务**（steps/plan/changedFiles 都还在），
     * 而不是新建一条从零开始的任务。
     */
    if (!taskId) return
    get().sendMessage('继续刚才的任务，从上次停下的地方接着做，别重复已经完成的步骤。', taskId)
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
    /* 只停当前这条 —— 别的对话在跑的不受影响 */
    const current = getActiveThread(useAppStore.getState())
    stopActiveRequest(current?.id)
    if (current) {
      set((s) => ({ sendingThreads: s.sendingThreads.filter((id) => id !== current.id) }))
    }
    /*
     * AG-032：停止是**异步生效**的（要等主进程把工具/命令收干净），
     * 光看按钮变回「发送」不够 —— 给一句回执，免得用户连点。
     */
    useUIStore.getState().showToast('info', '已停止', '这一轮不再往下跑，已经产出的内容留在对话里')
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

/*
 * AG-026：订阅 activeThreadId 变化切换草稿。用 store 订阅而不是在 setActiveThread
 * 里手动调（避免 useAppStore import useThreadStore 的循环依赖），切线程入口再多也只靠这一处。
 */
let lastDraftThread = useAppStore.getState().activeThreadId
useAppStore.subscribe((state) => {
  const current = state.activeThreadId
  if (current === lastDraftThread) return
  useThreadStore.getState().switchDraft(lastDraftThread, current)
  lastDraftThread = current
})
