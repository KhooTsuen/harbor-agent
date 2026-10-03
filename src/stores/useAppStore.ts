import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_PROJECTS, DEFAULT_THREADS } from '@/lib/mock'
import {
  appendMessage as appendToDisk,
  useRealBackend,
  importSessions,
  updateSessionMeta,
} from '@/lib/backend'
import { projectsBridgeReady, setProjectActive as persistProjectActive } from '@/lib/projectsApi'
import { touch, type AppState } from './app/types'
import { makeMessageActions } from './app/messageActions'
import { makeThreadEditActions } from './app/threadEdits'
import { makeProjectActions } from './app/projectActions'
import { makeDiskActions } from './app/diskActions'
import { makeThreadFolderActions } from './app/threadFolders'
import { appPersistOptions } from './app/persistOptions'
import { mergeImport } from '@/lib/migrations'
import { useUIStore } from './useUIStore'
import { onLeaveThread } from './thread/clarifyGuard'
export { getActiveProject, getActiveThread, sortThreads } from './app/selectors'

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      /* Electron 启动时绝不先塞演示项目；真实会话由 loadFromDisk 读取。 */
      projects: useRealBackend ? [] : DEFAULT_PROJECTS,
      threads: useRealBackend ? [] : DEFAULT_THREADS,
      activeProjectId: useRealBackend ? '' : (DEFAULT_PROJECTS[0]?.id ?? ''),
      activeThreadId: useRealBackend ? '' : (DEFAULT_THREADS[0]?.id ?? ''),
      loadingThreadId: null,

      /* ── 项目 ─────────────────────────────────── */

      /* 项目动作：见 app/projectActions.ts（要 get —— 置顶/归档得知道下一个值） */
      ...makeProjectActions(set, get),

      /* 磁盘读写（loadFromDisk / openFromDisk）：见 app/diskActions.ts */
      ...makeDiskActions(set, get),

      /* 新建对话 / 挂到目录（归属规则在这里）：见 app/threadFolders.ts */
      ...makeThreadFolderActions(set, get),

      replaceThreadId: (pendingId, realId) =>
        set((s) => ({
          threads: s.threads.map((t) => (t.id === pendingId ? { ...t, id: realId } : t)),
          activeThreadId: s.activeThreadId === pendingId ? realId : s.activeThreadId,
        })),

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
        /* 切走之前先收掉属于刚离开那条对话的澄清卡（2026-10-04，小尾巴 #4）——
           细节与来由见 stores/thread/clarifyGuard.ts */
        onLeaveThread(get().activeThreadId)

        set({ activeThreadId: id })
        const thread = get().threads.find((t) => t.id === id)
        if (thread) set({ activeProjectId: thread.projectId })

        /* 磁盘模式下把完整消息读进来 */
        if (useRealBackend) {
          const current = get().threads.find((t) => t.id === id)
          if (current && current.messages.length === 0) void get().openFromDisk(id)
        }
      },

      setActiveProject: (id) => {
        set({ activeProjectId: id })
        /* 顺手落盘（内核 activeId）—— 不写的话「上次在哪个项目」重启就丢 */
        void persistProjectActive(id).then((result) => {
          if (!result.ok && projectsBridgeReady()) {
            useUIStore.getState().showToast('error', '切换工作项目没能保存', result.error)
          }
        })
      },

      togglePinThread: (id) => {
        const pinned = get().threads.find((t) => t.id === id)?.pinned !== true
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
        }))
        /* AG-032：置顶之后那行只是换了个位置，不解释一下看不出来 */
        useUIStore.getState().showToast('info', pinned ? '已置顶' : '已取消置顶')
      },

      toggleArchiveThread: (id) => {
        const archived = get().threads.find((t) => t.id === id)?.archived !== true
        set((s) => ({
          threads: s.threads.map((t) => (t.id === id ? { ...t, archived: !t.archived } : t)),
        }))
        /* AG-032：归档 = 这一行从列表里消失，得说清它去哪了 */
        useUIStore.getState().showToast('info', archived ? '已归档' : '已取消归档')
      },

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
          threads: s.threads.map((t) => {
            if (t.id !== id) return t
            /*
             * AG-005：顺手记一条历史（时间线要显示「走过的路」）。
             * 相邻去重 —— `executing` 在一轮里会被反复转移（每个工具一次），
             * 不去重的话历史全是同一个词。这是**事件驱动**的记录，
             * 不是渲染层自己推断状态。
             */
            const history = t.phaseHistory ?? []
            const next =
              history[history.length - 1] === phase ? history : [...history, phase].slice(-24)
            return touch({ ...t, phase, phaseHistory: next })
          }),
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
          loadingThreadId: null,
        }),

      workdir: '',
      /** 换工作目录。不能只改字段 —— 会话和右栏文件树都挂在它上面，得重拉 */
      setWorkdir: async (dir) => {
        set({ workdir: dir })
        await get().loadFromDisk()
      },

      /* loadFromDisk / openFromDisk 已挪到 app/diskActions.ts（那边还要管 loadingThreadId） */

      persistMessage: (id, message) => {
        if (useRealBackend) void appendToDisk(id, message)
      },

      persistMeta: (id, patch) => {
        if (useRealBackend) void updateSessionMeta(id, patch)
      },
    }),
    {
      /* 持久化选项（含 partialize —— 别把整份状态写进 localStorage）：见 app/persistOptions.ts */
      ...appPersistOptions,
    },
  ),
)
