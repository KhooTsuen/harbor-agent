import { create } from 'zustand'
import type { ChangeSetDiff, ChangeSetSummary, TaskRecord, TaskRecoveryItem } from '@/types/safety'
import type { RollbackResult } from '@/lib/checkpointRollbackApi'
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

/**
 * AG-052：刚刚那次「撤销检查点之后的改动」。
 *
 * 存起来而不是只弹个 toast —— 用户要能回审查面板**对着看**这次回退动了什么
 * （需求原话：「撤销后在审查面板能看到这次回退的记录」）。
 * 只活在本次会话里：磁盘上的真相是改动事务的 `rolledBackAt` / 任务台账，
 * 这里不另存一份历史（那是第二份真相）。
 */
export interface RollbackRecord {
  taskId: string
  checkpointLabel: string
  at: number
  result: RollbackResult
}

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
  /**
   * 拉 diff 时的失败原因（空串 = 没失败）。
   *
   * 为什么要有这一格：`changesetDiff()` 内部 catch 完返回空壳，界面分不出
   * 「真的没有改动」和「读取失败」—— 第二阶段要求这两种情况分开说。
   * 只活在内存里，不落盘。
   */
  diffError: string
  /** 刚刚那次回退（AG-052）—— 审查面板顶部那条记录；null = 这次会话还没撤过 */
  lastRollback: RollbackRecord | null
  loaded: boolean
  refresh: (workdir?: string) => Promise<void>
  /**
   * 只重拉「当前对话那一批改动」。
   *
   * ★ 为什么要单独一个动作（第二阶段补）：`refresh()` 一次拉四样东西
   *   （全量任务 / 可恢复任务 / 改动清单 / diff），它只在「有事发生」时被调
   *   （工具跑完、一轮起止、窗口重新可见）。可**切换对话**不算那类事件 ——
   *   于是切到一条有改动的对话，「审查」和顶栏的 +N −M 还停在上一条对话的数上，
   *   显示成「还没有改动」，而内核里那批改动明明在。
   *   这里只做一件事：按 sessionId 重新问一次 diff（一个 IPC，不拉别的）。
   */
  refreshDiff: (sessionId: string) => Promise<void>
  noteRollback: (record: RollbackRecord | null) => void
}

let diffRequest = 0

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  unfinished: [],
  changesets: [],
  diff: null,
  diffError: '',
  lastRollback: null,
  loaded: false,
  noteRollback: (record) => set({ lastRollback: record }),
  /*
   * 只问 diff（切换对话时调）。成功失败都写回：失败要说「读取失败」，
   * 不能把上一条对话的旧 diff 留在界面上当成本条对话的。
   */
  refreshDiff: async (sessionId) => {
    const request = ++diffRequest
    try {
      const diff = await changesetDiff(sessionId)
      if (request === diffRequest && useAppStore.getState().activeThreadId === sessionId)
        set({ diff, diffError: '' })
    } catch (error) {
      if (request === diffRequest && useAppStore.getState().activeThreadId === sessionId)
        set({
          diff: null,
          diffError: error instanceof Error ? error.message : '读取改动失败',
        })
    }
  },
  /*
   * 一次刷新同时拿「全量任务」「可恢复任务」「可撤销改动」。
   * 不从 tasks 在前端推导 unfinished：恢复清单还带 envChanged / canResume，
   * 那些必须由主进程检查真实文件环境，前端自己算会形成第二份真相。
   */
  refresh: async (workdir = '') => {
    const sessionId = useAppStore.getState().activeThreadId
    const request = ++diffRequest
    const [tasks, unfinished, list, diffResult] = await Promise.all([
      taskList({ limit: 200, workdir }),
      taskRecovery(workdir),

      changesetList({ limit: 5 }),
      /* 审查标签看的是**当前这条对话**的改动 */
      changesetDiff(sessionId).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ])
    /*
     * diff 单独判成败：其余三项成功、只有它失败时，界面该说「读取失败」，
     * 而不是把上一次的旧 diff 当成这次的（也不能让整次 refresh 白跑）。
     */
    const diff = diffResult.ok ? diffResult.value : null
    const diffError = diffResult.ok
      ? ''
      : diffResult.error instanceof Error
        ? diffResult.error.message
        : '读取改动失败'
    const currentDiff =
      request === diffRequest && useAppStore.getState().activeThreadId === sessionId
    set({
      tasks,
      unfinished,
      /* 只看「提交过、还没撤、真改过文件」的那种 */
      changesets: list.filter((c) => c.status === 'committed' && c.fileCount > 0),
      ...(currentDiff ? { diff, diffError } : {}),
      loaded: true,
    })
  },
}))

/** 这条对话有没有没干完的任务（侧栏黄点用） */
export function useThreadHasTask(threadId: string): boolean {
  return useTaskStore((s) => s.unfinished.some((task) => task.sessionId === threadId))
}
