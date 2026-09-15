import type { Project, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   useAppStore 的选择器与排序

   抽出来是因为它们**不依赖 store 实例**，纯函数，可以单独测。
   ══════════════════════════════════════════════════════════════ */

interface StateSlice {
  threads: Thread[]
  projects: Project[]
  activeThreadId: string
  activeProjectId: string
}

export function getActiveThread(state: StateSlice): Thread | undefined {
  return state.threads.find((t) => t.id === state.activeThreadId)
}

export function getActiveProject(state: StateSlice): Project | undefined {
  return state.projects.find((p) => p.id === state.activeProjectId)
}

/** 线程按「固定优先 + 最近更新」排序 */
export function sortThreads(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}
