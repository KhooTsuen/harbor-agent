import type { Project } from '@/types'
import type { ProjectSaveInput } from '@/types/projects'
import { uid } from '@/lib/utils'
import { projectsBridgeReady, removeProject, saveProject } from '@/lib/projectsApi'
import { useUIStore } from '@/stores/useUIStore'
import { fallbackProjectFor, projectFromRecord } from './workspaceGroups'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   项目（= 对话文件夹）的动作

   从 useAppStore.ts 拆出来的 —— 那边过 300 行了。
   这一段只管「项目本身的增删改」，和线程、磁盘加载没关系。

   ★ 每个动作都是「**先改本地、再异步落盘**」：
     ① 本地 `set` 立即更新 —— 点了就要有反应（重命名后光标不该卡在那儿）；
     ② `saveProject` / `removeProject` 异步写进内核登记表（`data/projects.json`）。
     落盘失败只影响「重启后还在不在」，所以只提示一句、**不回滚本地** ——
     把界面弹回去反倒让人以为「点了没生效」（这正是本次要修的毛病）。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
type Getter = () => AppState

type ProjectActions = Pick<
  AppState,
  | 'createProject'
  | 'deleteProject'
  | 'renameProject'
  | 'updateProjectMeta'
  | 'togglePinProject'
  | 'toggleArchiveProject'
>

/** 落盘失败了要说一声 —— 不说的话用户以为存下了，重启才发现没有 */
function reportFailure(action: string, error?: string): void {
  /* 浏览器预览 / 桥没接上：本来就不落盘，不算失败，别拿红条吓人 */
  if (!projectsBridgeReady()) return
  useUIStore.getState().showToast('error', `${action}没能保存`, error)
}

/** 本地已经改完了，这里只负责把它写下去 */
function pushProject(input: ProjectSaveInput, action: string): void {
  void saveProject(input).then((result) => {
    if (!result.ok) reportFailure(action, result.error)
  })
}

export function makeProjectActions(set: Setter, get: Getter): ProjectActions {
  return {
    createProject: (name, path) => {
      const clean = name.trim() || '未命名项目'
      const root = path.trim()
      /*
       * 临时 id：真 id **必须来自内核**（`proj_xxx`，见 core/projects.cjs 的 newProjectId）——
       * 项目级记忆挂的就是它，前端自己编一个会让记忆全部失配。
       * 所以先本地建一条占位（形状与内核一致），落盘成功后拿内核那条覆盖它。
       */
      const tempId = uid('proj')
      const now = Date.now()
      const project: Project = {
        id: tempId,
        name: clean,
        description: '',
        path: root,
        branch: 'main',
        icon: '',
        color: '',
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      set((s) => ({ projects: [project, ...s.projects], activeProjectId: tempId }))

      void saveProject({ name: clean, root }).then((result) => {
        if (!result.ok || !result.item) {
          reportFailure('新建项目', result.error)
          return
        }
        const saved = projectFromRecord(result.item)
        set((s) => {
          /*
           * 按**本地临时 id** 找那一条来覆盖，不是按内核 id 找 —— 临时 id 换掉之后
           * 就没别的特征能定位它了（内核的 id 是新生成的）。
           * 万一那一条已经不在（用户抢在落盘完成前删了它）就什么都不做，
           * 别把一条刚被删掉的项目又插回侧栏。
           */
          if (!s.projects.some((p) => p.id === tempId)) return {}
          return {
            projects: s.projects.map((p) => (p.id === tempId ? saved : p)),
            /* 这一瞬理论上不会有新会话挂上来，但改一下不花钱 —— 不改的话
               那些会话会因为「查不到项目」而落到兜底分组里 */
            threads: s.threads.map((t) =>
              t.projectId === tempId ? { ...t, projectId: saved.id } : t,
            ),
            activeProjectId: s.activeProjectId === tempId ? saved.id : s.activeProjectId,
          }
        })
      })

      return tempId
    },

    deleteProject: (id) => {
      set((s) => {
        const projects = s.projects.filter((p) => p.id !== id)
        /*
         * ⚠️ **对话一条都不删** —— 内核 `projects:remove` 只删登记项（会话和任务是用户的
         * 东西）。以前这里是 `threads.filter(t => t.projectId !== id)`，等于把用户的
         * 对话藏起来 —— 现在改成给它们补一个兜底分组：projectId 还在、项目没了，
         * 重新读盘时也是这个结果（见 fallbackProjectFor），所以重启前后一致，
         * 不会「删一个项目、丢一间对话」。
         */
        const orphans = s.threads.filter((t) => t.projectId === id)
        const next = orphans.length > 0 ? [...projects, fallbackProjectFor(id, orphans)] : projects
        return {
          projects: next,
          activeProjectId: s.activeProjectId === id ? (next[0]?.id ?? '') : s.activeProjectId,
          /* activeThreadId 也不动：移除一个项目不该把用户正在看的对话切走 */
        }
      })

      void removeProject(id).then((result) => {
        if (!result.ok) reportFailure('移除项目', result.error)
      })
    },

    renameProject: (id, name) => {
      const trimmed = name.trim()
      /* 空名字当没改（和以前一样保留原名，也省掉一次必然失败的内核请求） */
      if (!trimmed) return
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
        ),
      }))
      /* 内核只改 name、**不动 id** —— 所以项目级记忆不会因为改名而失配 */
      pushProject({ id, name: trimmed }, '重命名项目')
    },

    updateProjectMeta: (id, patch) => {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
      pushProject({ id, ...patch }, '项目信息')
    },

    togglePinProject: (id) => {
      const next = !(get().projects.find((p) => p.id === id)?.pinned ?? false)
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, pinned: next } : p)) }))
      pushProject({ id, pinned: next }, next ? '置顶项目' : '取消置顶项目')
    },

    toggleArchiveProject: (id) => {
      const next = !(get().projects.find((p) => p.id === id)?.archived ?? false)
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, archived: next } : p)),
      }))
      pushProject({ id, archived: next }, next ? '归档项目' : '取消归档项目')
    },
  }
}
