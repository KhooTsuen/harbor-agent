import { create } from 'zustand'
import type { TaskRecoveryItem } from '@/types/safety'
import { taskRecovery } from '@/lib/safetyApi'

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
  unfinished: TaskRecoveryItem[]
  refresh: () => Promise<void>
}

export const useTaskStore = create<TaskState>((set) => ({
  unfinished: [],
  /*
   * AG-012：改用 `task:recovery` 而不是 `task:unfinished`。
   * 两者都答「哪些任务没干完」，但前者多带三样用户做决定需要的东西：
   * 停在哪一步、停手后哪些文件被动过、恢复过几次。
   */
  refresh: async () => {
    const list = await taskRecovery()
    set({ unfinished: list })
  },
}))

/** 这条对话有没有没干完的任务（侧栏黄点用） */
export function useThreadHasTask(threadId: string): boolean {
  return useTaskStore((s) => s.unfinished.some((task) => task.sessionId === threadId))
}
