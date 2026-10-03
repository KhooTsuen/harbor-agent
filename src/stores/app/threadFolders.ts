import type { Project, Thread } from '@/types'
import { makeEmptyThread } from '@/lib/mock'
import { uid } from '@/lib/utils'
import { updateSessionMeta, useRealBackend } from '@/lib/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { folderIdFor } from './folderIds'
import { fallbackProjectFor } from './workspaceGroups'
import { onLeaveThread } from '../thread/clarifyGuard'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   新建对话 / 把对话挂到目录 —— 也就是「这条对话归哪个对话文件夹」

   从 `useAppStore.ts` 拆出来的（那边加完归属规则就 310 行，破了硬约束 #2）。
   这两个动作是一对，而且共用同一条归属规则，放一起才看得出来。

   ── 归属规则（用户 2026-09-28 报的 bug 就出在这）──────────────
   侧栏分两栏，判据是**会话自己的 `projectId`**（`Sidebar.tsx`：`!t.projectId`
   才算「单独对话」）。而「对话文件夹」那一栏的「新建对话并指定目录」传的是
   `('', 目录)` —— 以前把空 projectId 原样带进新对话，于是它明明有工作目录，
   却掉进了下半栏「单独对话」。

   现在：**给了目录就以目录为准**（目录本身就定义了文件夹）。目录 → 归属用
   `folderIdFor`（= `dir:<目录>`，与内核 `electron/core/project-paths.cjs` 的
   `dirIdFor` 逐字一致），所以内存里的归属和之后从磁盘读回来的一致 ——
   不会重开一次就「搬家」。

   还有个坑：分组列表是**遍历 `projects`** 渲染的，所以 projectId 指向一个
   不存在的项目时，那条会话哪一栏都不会出现（凭空消失）。目录还没登记过就
   用 `fallbackProjectFor` 补一个兜底分组（`projectActions.deleteProject`
   用的是同一种分组）。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
type Getter = () => AppState

type ThreadFolderActions = Pick<AppState, 'createThread' | 'setThreadWorkdir' | 'deleteFolder'>

/** 目录还没有登记项时补一个兜底分组（已有 / 空 id 就原样返回那个数组） */
export function withFallbackFolder(projects: Project[], id: string, threads: Thread[]): Project[] {
  if (!id || projects.some((p) => p.id === id)) return projects
  return [...projects, fallbackProjectFor(id, threads)]
}

/** 目录 → 归属（已有登记项就用它，没有就按目录现推） */
function ownerIdFor(projects: Project[], workdir: string): string {
  if (!workdir) return ''
  return projects.find((p) => p.path === workdir)?.id ?? folderIdFor(workdir)
}

export function makeThreadFolderActions(set: Setter, get: Getter): ThreadFolderActions {
  return {
    createThread: (projectId, explicitWorkdir) => {
      /* projectId：没传=用当前选中；给了=放进那个文件夹；''=明确要单独对话 */
      const pid = projectId === undefined ? get().activeProjectId : projectId
      const project = get().projects.find((p) => p.id === pid)
      /* 显式给的目录优先（可能是还没建文件夹的新目录） */
      const workdir = explicitWorkdir !== undefined ? explicitWorkdir : (project?.path ?? '')
      /* 给了目录就以目录为准；没给才用传进来的那个 */
      const targetId = explicitWorkdir ? ownerIdFor(get().projects, explicitWorkdir) : pid

      const build = (id?: string) => {
        const configuredModel = useConfigStore.getState().config?.assistant.model
        return {
          ...makeEmptyThread(targetId),
          ...(id ? { id } : {}),
          workdir,
          ...(configuredModel ? { model: configuredModel } : {}),
        }
      }

      /* 新对话就归在新目录那一栏下：activeProjectId 跟着走，下次「新建对话」还在那儿 */
      const push = (thread: Thread): void => {
        /* 「新建对话」也是一次离开（真机验证时发现的：它不走 setActiveThread，
           于是卡开着点新建对话，澄清卡跟到了新对话里）—— 收尾在一处，见 clarifyGuard */
        onLeaveThread(get().activeThreadId)
        set((s) => ({
          projects: withFallbackFolder(s.projects, targetId, [thread]),
          threads: [thread, ...s.threads],
          activeThreadId: thread.id,
          activeProjectId: targetId,
        }))
      }

      /* 磁盘模式：先用 pending id 占位，第一次发送时才落文件 */
      if (useRealBackend) {
        const id = uid('pending')
        push(build(id))
        return id
      }

      const thread = build()
      push(thread)
      return thread.id
    },

    /* 换一条对话的工作目录（挂到文件夹 / 换文件夹 / 摘掉 ''）。
       磁盘模式下要同时改会话文件 meta —— 分组是从磁盘读的。 */
    setThreadWorkdir: async (threadId, workdir) => {
      /* 同 createThread：归属按目录推；目录没登记过就补一个兜底分组（不然它哪栏都不出现） */
      const nextId = ownerIdFor(get().projects, workdir)

      set((s) => {
        const next = s.threads.map((t) =>
          t.id === threadId ? { ...t, workdir, projectId: nextId } : t,
        )
        return {
          threads: next,
          projects: withFallbackFolder(
            s.projects,
            nextId,
            next.filter((t) => t.id === threadId),
          ),
        }
      })

      if (useRealBackend && !threadId.startsWith('pending_')) {
        await updateSessionMeta(threadId, { workdir })
        await get().loadFromDisk()
      }
    },

    /**
     * 删掉一个「对话文件夹」：里面的对话 **+** 文件夹本身。
     *
     * ── 为什么不能直接调 `deleteProject` ──
     * 那个只删登记项，会话一个字节都不动 —— 于是它们当场按 workdir 重新聚成一个
     * **同名兜底分组**，文件夹原地复活。用户报的就是这个：
     * 「对话文件夹也没有删除功能」。他 2026-09-29 明确选了「连对话一起删掉」。
     *
     * ── 三条纪律 ──
     *   ① 连**已归档**的一起删。只删界面上看得见的那几条，归档的会留下来，
     *      而它们同样会复活一个兜底分组（侧栏看起来像「删不干净」）。
     *   ② 顺序不能反：先删对话、再删登记项。反过来的话中间那一下又是「复活」。
     *   ③ 磁盘上那个目录**一个字节都不动** —— 删的只有应用自己的数据
     *      （会话文件 + 任务台账），用户的工作目录不是我们的东西。
     *
     * @returns 删掉的对话条数（确认框与提示都要用它说清除掉了什么）
     */
    deleteFolder: async (projectId) => {
      const ids = get()
        .threads.filter((t) => t.projectId === projectId)
        .map((t) => t.id)
      /*
       * 逐条删，**不并发**：`deleteThread` 每条都要停任务、清台账、删会话文件，
       * 并发跑就是同时写三处磁盘 —— 中途失败时没人说得清删到哪一条了。
       */
      for (const id of ids) await get().deleteThread(id)
      get().deleteProject(projectId)
      return ids.length
    },
  }
}
