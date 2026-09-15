import type { Project } from '@/types'
import { uid } from '@/lib/utils'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   项目（= 对话文件夹）的动作

   从 useAppStore.ts 拆出来的 —— 那边过 300 行了。
   这一段只管「文件夹本身的增删改」，和线程、磁盘加载没关系。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

type ProjectActions = Pick<
  AppState,
  | 'createProject'
  | 'deleteProject'
  | 'renameProject'
  | 'updateProjectMeta'
  | 'togglePinProject'
  | 'toggleArchiveProject'
>

export function makeProjectActions(set: Setter): ProjectActions {
  return {
    createProject: (name, path) => {
      const id = uid('proj')
      const project: Project = {
        id,
        name: name.trim() || '未命名项目',
        description: '',
        path: path.trim() || `~/projects/${name.trim() || 'untitled'}`,
        branch: 'main',
        icon: '',
        color: '',
        pinned: false,
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      set((s) => ({ projects: [project, ...s.projects], activeProjectId: id }))
      return id
    },

    deleteProject: (id) =>
      set((s) => {
        const projects = s.projects.filter((p) => p.id !== id)
        const threads = s.threads.filter((t) => t.projectId !== id)
        return {
          projects,
          threads,
          activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? '') : s.activeProjectId,
          activeThreadId: threads.some((t) => t.id === s.activeThreadId)
            ? s.activeThreadId
            : (threads[0]?.id ?? ''),
        }
      }),

    renameProject: (id, name) =>
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p,
        ),
      })),

    updateProjectMeta: (id, patch) =>
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

    togglePinProject: (id) =>
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)),
      })),

    toggleArchiveProject: (id) =>
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, archived: !p.archived } : p)),
      })),

    /* ── 线程 ─────────────────────────────────────────── */
  }
}
