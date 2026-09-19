import { create } from 'zustand'
import type { TaskRecord, TaskRecoveryItem } from '@/types/safety'
import { taskList, taskRecovery } from '@/lib/safetyApi'

/* ══════════════════════════════════════════════════════════════
   未完成的任务

   从 TaskBanner 里抽出来的。原因：那个组件原来把「**所有**对话的未完成任务」
   都摊在对话顶部 —— 于是不管你切到哪条对话，都在弹同一个横幅
   （用户报的「弹得太频繁」）。

   现在分成两处用：
     · 侧栏对话行   → 有未完成任务的对话挂一个黄点（一眼知道是哪条）
     · 对话顶部横幅 → **只显示当前这条对话自己的**未完成任务
   ══════════════════════════════════════════════════════════════ */

interface TaskState {
  /** AG-028：全局任务中心的唯一前端快照（后端 task.cjs 仍是唯一真相源） */
  tasks: TaskRecord[]
  unfinished: TaskRecoveryItem[]
  loaded: boolean
  refresh: () => Promise<void>
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  unfinished: [],
  loaded: false,
  /*
   * 一次刷新同时拿「全量任务」和「可恢复任务」。
   * 不从 tasks 在前端推导 unfinished：恢复清单还带 envChanged / canResume，
   * 那些必须由主进程检查真实文件环境，前端自己算会形成第二份真相。
   */
  refresh: async () => {
    const [tasks, unfinished] = await Promise.all([taskList({ limit: 200 }), taskRecovery()])
    set({ tasks, unfinished, loaded: true })
  },
}))

/** 这条对话有没有没干完的任务（侧栏黄点用） */
export function useThreadHasTask(threadId: string): boolean {
  return useTaskStore((s) => s.unfinished.some((task) => task.sessionId === threadId))
}
