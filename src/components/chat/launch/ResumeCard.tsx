import { Button } from '@/components/ui/Button'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { taskUpdate } from '@/lib/safetyApi'
import { colorOf } from '@/lib/statusLanguage'
import { formatUpdated, taskProgress } from '@/components/chat/taskCenterModel'
import type { TaskRecoveryItem } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   开屏「最近工作」：中断任务的恢复卡（设计文档 §6.4 / §9 / §23.10）

   数据全部来自**任务台账**，不靠模型说"我做完了"：
     · 停了多久、做到哪一步 —— 台账里读；
     · 「继续」= 复用原任务（taskId 随消息带回内核，不重复已完成步骤）；
     · 「放弃」只结束任务，**不自动回滚文件**（文案里说清楚）；
     · 停手后有文件被动过 → 明说，让用户先看一眼再继续。
   ══════════════════════════════════════════════════════════════ */

export function ResumeCard({
  tasks,
  onRefresh,
}: {
  tasks: TaskRecoveryItem[]
  /** 放弃后让开屏重新拉一次清单 */
  onRefresh: () => void
}) {
  if (tasks.length === 0) return null

  const giveUp = (task: TaskRecoveryItem): void => {
    void (async () => {
      await taskUpdate(task.id, { status: 'cancelled' })
      useUIStore.getState().showToast('info', '任务已放弃', '文件改动没有被回滚，仍然在原处。')
      onRefresh()
    })()
  }

  return (
    <section className="w-full max-w-xl" aria-label="最近工作">
      <p className="mb-1.5 px-1 text-2xs text-fg-tertiary">最近工作</p>
      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => {
          const progress = taskProgress(task)
          const stopped = formatUpdated(task.pausedAt ?? task.updatedAt ?? 0)
          const envChanged = task.envChanged ?? []
          return (
            <div
              key={task.id}
              className="rounded-base border border-line-hairline bg-bg-raised/40 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense font-medium text-fg-primary">
                    {task.title || task.goal || '未命名任务'}
                  </span>
                  <span className="mt-0.5 block text-2xs text-fg-secondary">
                    上次任务{stopped}停止 · 已完成 {progress.done}/{progress.total} 步
                  </span>
                  {envChanged.length > 0 ? (
                    <span className="mt-0.5 block text-2xs" style={{ color: colorOf('warning') }}>
                      停手后有 {envChanged.length} 个改动过的文件被动过，继续前先看一眼
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => useThreadStore.getState().resumeTask(task.id)}
                  >
                    继续
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => useUIStore.getState().setActiveRightTab('tasks')}
                  >
                    查看
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => giveUp(task)}>
                    <span className="text-danger">放弃</span>
                  </Button>
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
