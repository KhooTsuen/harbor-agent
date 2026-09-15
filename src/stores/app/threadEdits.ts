import type { Thread } from '@/types'
import { uid } from '@/lib/utils'
import { useRealBackend, updateSessionMeta } from '@/lib/backend'
import type { AppState } from './types'

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
  'branchThread' | 'editUserMessage' | 'updateConversationState' | 'updateThreadSettings'
>

export function makeThreadEditActions(set: Setter, get: () => AppState): EditedActions {
  return {
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
