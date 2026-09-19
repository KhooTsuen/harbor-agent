import { create } from 'zustand'
import type { ChangeSetDiff, ChangeSetSummary, TaskRecord, TaskRecoveryItem } from '@/types/safety'
import { changesetDiff, changesetList, taskList, taskRecovery } from '@/lib/safetyApi'
import { useAppStore } from './useAppStore'

/* ═══════════════════════════════════════════════════════════════
   任务快照

   AG-028 从 TaskBanner 里抽出来的。原因：那个组件原来把「**所有**对话的未完成任务」
   都摊在对话顶部 —— 于是不管你切到哪条对话，都在弹同一个横幅
   （用户报的「弹得太频繁」）。

   现在这份快照服务两处：
     · 侧栏对话行   → 有未完成任务的对话挂一个黄点（一眼知道是哪条）
     · 右栏「任务」 → 全局任务中心（横幅已整个并到这里）
   ═══════════════════════════════════════════════════════════════ */

interface TaskState {
  /** AG-028：全局任务中心的唯一前端快照（后端 task.cjs 仍是唯一真相源） */
  tasks: TaskRecord[]
  unfinished: TaskRecoveryItem[]
  /** 可撤销的改动（已提交 + 真改过文件）—— AG-028 从横幅搬过来的 */
  changesets: ChangeSetSummary[]
  /**
   * AG-036：「最近一批改动」的 diff（右栏审查标签 + 顶栏那个 +N −M 都读它）。
   *
   * 为什么和 tasks 一起刷：刷新的时机本来就是「有事发生了」（工具跑完、
   * 计划变了、一轮起止、窗口重新可见）—— 那正好也是 diff 会变的时候，
   * 各拉一份不如一次拉齐（免得两个地方看到不同的「最近一次改动」）。
   */
  diff: ChangeSetDiff | null
  loaded: boolean
  refresh: () => Promise<void>
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  unfinished: [],
  changesets: [],
  diff: null,
  loaded: false,
  /*
   * 一次刷新同时拿「全量任务」「可恢复任务」「可撤销改动」。
   * 不从 tasks 在前端推导 unfinished：恢复清单还带 envChanged / canResume，
   * 那些必须由主进程检查真实文件环境，前端自己算会形成第二份真相。
   */
  refresh: async () => {
    const [tasks, unfinished, list, diff] = await Promise.all([
      taskList({ limit: 200 }),
      taskRecovery(),
      changesetList({ limit: 5 }),
      /* 审查标签看的是**当前这条对话**的改动 */
      changesetDiff(useAppStore.getState().activeThreadId),
    ])
    set({
      tasks,
      unfinished,
      /* 只看「提交过、还没撤、真改过文件」的那种 */
      changesets: list.filter((c) => c.status === 'committed' && c.fileCount > 0),
      diff,
      loaded: true,
    })
  },
}))

/** 这条对话有没有没干完的任务（侧栏黄点用） */
export function useThreadHasTask(threadId: string): boolean {
  return useTaskStore((s) => s.unfinished.some((task) => task.sessionId === threadId))
}
