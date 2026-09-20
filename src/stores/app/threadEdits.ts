import type { Thread } from '@/types'
import { uid } from '@/lib/utils'
import { abortChat, removeSession, useRealBackend, updateSessionMeta } from '@/lib/backend'
import { taskPurgeBySession } from '@/lib/safetyApi'
import type { AppState } from './types'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   线程级的编辑动作：分支 / 改用户消息 / 对话状态 / 本会话设置

   从 useAppStore.ts 拆出来的 —— 那边装完项目、线程、导入导出、
   磁盘加载之后过 300 行了。这些都是「对单条线程做点什么」，
   和 store 的加载/持久化是两件事。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

/*
 * 返回类型用 Pick 而不是 Partial —— Partial 会让这几个动作变成「可选」，
 * 和 AppState 里「必选」的声明对不上，store 合起来就报类型错（踩过）。
 */
type EditedActions = Pick<
  AppState,
  | 'branchThread'
  | 'editUserMessage'
  | 'updateConversationState'
  | 'updateThreadSettings'
  | 'deleteThread'
>

export function makeThreadEditActions(set: Setter, get: () => AppState): EditedActions {
  return {
    /*
     * 删对话 = 删这条对话的**任务历史**一起删（用户明确要的）。
     *
     * 三件事，顺序不能反：
     *   ① 先停掉这条对话里还在跑的任务 —— 不然任务还在后台跑、台账却被删了，
     *    它会继续往一个不存在的任务里写东西（幽灵任务）
     *   ② 清任务台账（按 sessionId 整批删）
     *   ③ 删会话文件
     *
     * @returns 清掉的任务条数（调用方用它说一句「一并清理了 N 条任务历史」）
     */
    deleteThread: async (id) => {
      let removed = 0
      if (useRealBackend) {
        try {
          await abortChat(id)
        } catch {
          /* 没在跑就没事；abort 失败也不该挡住删除 */
        }
        removed = await taskPurgeBySession(id)
        void removeSession(id)
      }
      set((s) => {
        const threads = s.threads.filter((t) => t.id !== id)
        const activeThreadId = s.activeThreadId === id ? (threads[0]?.id ?? '') : s.activeThreadId
        return { threads, activeThreadId }
      })
      return removed
    },

    branchThread: (threadId, messageId) => {
      const source = get().threads.find((t) => t.id === threadId)
      if (!source) return ''
      const cut = messageId
        ? source.messages.findIndex((m) => m.id === messageId)
        : source.messages.length - 1
      const messages = source.messages
        .slice(0, Math.max(0, cut + 1))
        .map((m) => ({ ...m, id: uid('msg'), threadId: '' }))
      const id = uid('branch')
      const branch: Thread = {
        ...source,
        id,
        title: `${source.title} · 分支`,
        messages: messages.map((m) => ({ ...m, threadId: id })),
        status: 'idle',
        titleAuto: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      set((s) => ({
        threads: [branch, ...s.threads],
        activeThreadId: id,
        activeProjectId: branch.projectId,
      }))
      /*
       * AG-032：分支之后会自动切到新对话，界面上「啪」地换了一条 ——
       * 不说一句用户会以为是切错地方了（消息动作和上一条动作两个入口都走这里）。
       */
      useUIStore.getState().showToast('success', '已创建分支', branch.title)
      return id
    },

    editUserMessage: (threadId, messageId, content) =>
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageId ? { ...m, content, edited: true } : m,
                ),
              }
            : t,
        ),
      })),

    updateConversationState: (threadId, patch) =>
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                conversationState: {
                  topic: '',
                  goal: '',
                  currentFocus: '',
                  entities: [],
                  decisions: [],
                  constraints: [],
                  openQuestions: [],
                  nextStep: '',
                  ...t.conversationState,
                  ...patch,
                  version: 1,
                  lastUpdated: new Date().toISOString(),
                },
              }
            : t,
        ),
      })),

    updateThreadSettings: (threadId, patch) => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, settings: { ...t.settings, ...patch } } : t,
        ),
      }))
      if (useRealBackend && !threadId.startsWith('pending_')) {
        void updateSessionMeta(threadId, {
          threadSettings: { ...patch } as Record<string, unknown>,
        })
      }
    },
  }
}
