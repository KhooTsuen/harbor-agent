import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_PROJECTS, DEFAULT_THREADS, makeEmptyThread } from '@/lib/mock'
import { uid } from '@/lib/utils'
import {
  appendMessage as appendToDisk,
  useRealBackend,
  importSessions,
  removeSession,
  updateSessionMeta,
} from '@/lib/backend'
import { fetchMessagesFromDisk, fetchWorkspaceFromDisk, folderIdFor } from './app/disk'
import { touch, type AppState } from './app/types'
import { makeMessageActions } from './app/messageActions'
import { makeThreadEditActions } from './app/threadEdits'
import { makeProjectActions } from './app/projectActions'
import { mergeImport } from '@/lib/migrations'
import { useConfigStore } from './useConfigStore'
export { getActiveProject, getActiveThread, sortThreads } from './app/selectors'

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      /* Electron 启动时绝不先塞演示项目；真实会话由 loadFromDisk 读取。 */
      projects: useRealBackend ? [] : DEFAULT_PROJECTS,
      threads: useRealBackend ? [] : DEFAULT_THREADS,
      activeProjectId: useRealBackend ? '' : (DEFAULT_PROJECTS[0]?.id ?? ''),
      activeThreadId: useRealBackend ? '' : (DEFAULT_THREADS[0]?.id ?? ''),

      /* ── 项目 ─────────────────────────────────────────── */

      /* 项目动作：见 app/projectActions.ts */
      ...makeProjectActions(set),

      createThread: (projectId, explicitWorkdir) => {
        /* projectId：没传=用当前选中；给了=放进那个文件夹；''=明确要单独对话 */
        const pid = projectId === undefined ? get().activeProjectId : projectId
        const project = get().projects.find((p) => p.id === pid)
        /* 显式给的目录优先（可能是还没建文件夹的新目录） */
        const workdir = explicitWorkdir !== undefined ? explicitWorkdir : (project?.path ?? '')

        const build = (id?: string) => {
          const configuredModel = useConfigStore.getState().config?.assistant.model
          return {
            ...makeEmptyThread(pid),
            ...(id ? { id } : {}),
            workdir,
            ...(configuredModel ? { model: configuredModel } : {}),
          }
        }

        /* 磁盘模式：先用 pending id 占位，第一次发送时才落文件 */
        if (useRealBackend) {
          const id = uid('pending')
          set((s) => ({ threads: [build(id), ...s.threads], activeThreadId: id }))
          return id
        }

        const thread = build()
        set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id }))
        return thread.id
      },

      /* 换一条对话的工作目录（挂到文件夹 / 换文件夹 / 摘掉 ''）。
         磁盘模式下要同时改会话文件 meta —— 分组是从磁盘读的。 */
      setThreadWorkdir: async (threadId, workdir) => {
        const project = get().projects.find((p) => p.path === workdir)

        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === threadId
              ? { ...t, workdir, projectId: workdir ? (project?.id ?? folderIdFor(workdir)) : '' }
              : t,
          ),
        }))

        if (useRealBackend && !threadId.startsWith('pending_')) {
          await updateSessionMeta(threadId, { workdir })
          await get().loadFromDisk()
        }
      },

      replaceThreadId: (pendingId, realId) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === pendingId ? { ...t, id: realId } : t)),
          activeThreadId: s.activeThreadId === pendingId ? realId : s.activeThreadId,
        })),

      deleteThread: (id) => {
        if (useRealBackend) void removeSession(id)
        set((s) => {
          const threads = s.threads.filter((t) => t.id !== id)
          const activeThreadId = s.activeThreadId === id ? (threads[0]?.id ?? '') : s.activeThreadId
          return { threads, activeThreadId }
        })
      },

      /* 用户手动改名：titleAuto = false，之后模型起的标题不会再盖掉它 */
      renameThread: (id, title) => {
        if (useRealBackend) void updateSessionMeta(id, { title })
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === id ? touch({ ...t, title: title.trim() || t.title, titleAuto: false }) : t,
          ),
        }))
      },

      /* 自动起标题：保持 titleAuto = true，下一轮还能被更好的覆盖（第一轮信息太少） */
      autoTitle: (id, title) => {
        const text = title.trim()
        if (!text) return
        if (useRealBackend) void updateSessionMeta(id, { title: text })
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === id ? touch({ ...t, title: text, titleAuto: true }) : t,
          ),
        }))
      },

      setActiveThread: (id) => {
        set({ activeThreadId: id })
        const thread = get().threads.find((t) => t.id === id)
        if (thread) set({ activeProjectId: thread.projectId })

        /* 磁盘模式下把完整消息读进来 */
        if (useRealBackend) {
          const current = get().threads.find((t) => t.id === id)
          if (current && current.messages.length === 0) void get().openFromDisk(id)
        }
      },

      setActiveProject: (id) => set({ activeProjectId: id }),

      togglePinThread: (id) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
        })),

      toggleArchiveThread: (id) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? { ...t, archived: !t.archived } : t)),
        })),

      addThreadTag: (id, tag) =>
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === id && tag && !t.tags.includes(tag) ? { ...t, tags: [...t.tags, tag] } : t,
          ),
        })),

      removeThreadTag: (id, tag) =>
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === id ? { ...t, tags: t.tags.filter((x) => x !== tag) } : t,
          ),
        })),

      markThreadExported: (id) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? { ...t, exportedAt: Date.now() } : t)),
        })),

      setThreadStatus: (id, status) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? touch({ ...t, status }) : t)),
        })),

      /* AG-001：阶段由主进程状态机推过来，前端只负责记下 */
      setThreadPhase: (id: string, phase: import('@/types').AgentPhase) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? touch({ ...t, phase }) : t)),
        })),

      setThreadMode: (id, mode) => {
        set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, mode } : t)) }))
        if (useRealBackend && !id.startsWith('pending_')) void updateSessionMeta(id, { mode })
      },

      setThreadModel: (id, model) => {
        set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, model } : t)) }))
        if (useRealBackend && !id.startsWith('pending_')) void updateSessionMeta(id, { model })
      },

      setThreadReasoning: (id, reasoning) => {
        set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, reasoning } : t)) }))
        /* 以前这里漏了持久化 —— 选完重启就回到默认值 */
        if (useRealBackend && !id.startsWith('pending_')) void updateSessionMeta(id, { reasoning })
      },

      /* 分支 / 编辑 / 对话状态 / 线程级设置：见 app/threadEdits.ts */
      ...makeThreadEditActions(set, get),

      /* 消息的增删改（含流式 patch）—— 在 app/messageActions.ts */
      ...makeMessageActions(set),

      applyImport: async (incoming) => {
        /* 磁盘模式先落盘（会生成新 id），再用返回值更新界面，否则 id 对不上 */
        const persisted =
          useRealBackend && incoming.threads.length > 0
            ? await importSessions(incoming.threads)
            : incoming.threads
        const state = get()
        const merged = mergeImport(state, { threads: persisted, projects: incoming.projects })
        set({ threads: merged.threads, projects: merged.projects })
        return { threads: merged.addedThreads, projects: merged.addedProjects }
      },

      resetAll: () =>
        set({
          projects: DEFAULT_PROJECTS,
          threads: DEFAULT_THREADS,
          activeProjectId: DEFAULT_PROJECTS[0]?.id ?? '',
          activeThreadId: DEFAULT_THREADS[0]?.id ?? '',
        }),

      workdir: '',
      /** 换工作目录。不能只改字段 —— 会话和右栏文件树都挂在它上面，得重拉 */
      setWorkdir: async (dir) => {
        set({ workdir: dir })
        await get().loadFromDisk()
      },

      loadFromDisk: async () => {
        if (!useRealBackend) return
        const result = await fetchWorkspaceFromDisk()
        set((state) => ({
          /* 每个有会话的工作目录 = 一个「对话文件夹」；没挂在目录上的在 threads 里 projectId 为空 */
          projects: result.folders.map((f) => f.project),
          threads: result.threads,
          activeProjectId: result.folders[0]?.project.id ?? '',
          activeThreadId: result.threads.some((t) => t.id === state.activeThreadId)
            ? state.activeThreadId
            : (result.threads[0]?.id ?? ''),
        }))
      },

      openFromDisk: async (id) => {
        if (!useRealBackend) return
        set({ activeThreadId: id })
        const messages = await fetchMessagesFromDisk(id)
        if (!messages) return
        set((state) => ({
          threads: state.threads.map((t) => (t.id === id ? { ...t, messages } : t)),
        }))
      },

      persistMessage: (id, message) => {
        if (useRealBackend) void appendToDisk(id, message)
      },

      persistMeta: (id, patch) => {
        if (useRealBackend) void updateSessionMeta(id, patch)
      },
    }),
    {
      name: 'personal-agent:app',
      version: 1,
      /* Electron 的真实磁盘是唯一数据源，不从旧 localStorage 恢复演示数据。 */
      skipHydration: useRealBackend,
    },
  ),
)
