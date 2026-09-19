import { useEffect, useMemo, useState } from 'react'
import { Ban, CheckCircle2, CircleDot, Clock3, PauseCircle, RefreshCw, XCircle } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import {
  TASK_GROUPS,
  currentStepOf,
  elapsedMs,
  formatDuration,
  formatUpdated,
  groupTasks,
  taskProgress,
} from './taskCenterModel'

const STATUS_STYLE: Record<TaskRecord['status'], { color: string; icon: typeof CircleDot }> = {
  running: { color: 'var(--accent-blue)', icon: CircleDot },
  paused: { color: 'var(--warning)', icon: PauseCircle },
  waiting_user: { color: 'var(--warning)', icon: Clock3 },
  completed: { color: 'var(--success)', icon: CheckCircle2 },
  failed: { color: 'var(--danger)', icon: XCircle },
  cancelled: { color: 'var(--fg-tertiary)', icon: Ban },
}

/** AG-028：全局后台任务中心。数据只来自 useTaskStore → 后端 task.cjs。 */
export function TaskCenter() {
  const tasks = useTaskStore((s) => s.tasks)
  const loaded = useTaskStore((s) => s.loaded)
  const refresh = useTaskStore((s) => s.refresh)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* 只有真的有 Running 才走秒表；空闲时不留常驻 interval。 */
  const hasRunning = tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  const groups = useMemo(() => groupTasks(tasks), [tasks])

  async function reload(): Promise<void> {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }

  if (!loaded) {
    return <p className="p-3 text-xs text-fg-tertiary">正在读取任务记录…</p>
  }

  if (tasks.length === 0) {
    return (
      <div aria-label="任务中心" className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={<CircleDot size={28} />}
          title="还没有后台任务"
          description="让 Agent 做一件事后，运行状态、当前步骤和结果会集中显示在这里。"
        />
      </div>
    )
  }

  return (
    <div aria-label="任务中心" className="min-h-0 flex-1 overflow-y-auto p-2.5">
      <header className="mb-2 flex items-center gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium text-fg-primary">后台任务</h2>
          <p className="text-2xs text-fg-tertiary">共 {tasks.length} 条 · 点击任务回到对应对话</p>
        </div>
        <IconButton label="刷新任务" size={28} onClick={() => void reload()}>
          <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
        </IconButton>
      </header>

      <div className="mb-2 flex flex-wrap gap-1 px-0.5">
        {TASK_GROUPS.map((group) => (
          <span
            key={group.status}
            className="rounded-pill border border-line-hairline bg-bg-raised px-2 py-0.5 text-2xs text-fg-secondary"
          >
            {group.label} {groups.get(group.status)?.length ?? 0}
          </span>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {TASK_GROUPS.map((group) => {
          const entries = groups.get(group.status) ?? []
          if (entries.length === 0) return null
          return (
            <section key={group.status} aria-label={group.label}>
              <h3 className="mb-1 px-0.5 text-2xs font-medium text-fg-tertiary">
                {group.label} · {entries.length}
              </h3>
              <div className="flex flex-col gap-1.5">
                {entries.map((task) => (
                  <TaskCenterRow
                    key={task.id}
                    task={task}
                    now={now}
                    active={task.sessionId === activeThreadId}
                    onOpen={() => task.sessionId && setActiveThread(task.sessionId)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function TaskCenterRow({
  task,
  now,
  active,
  onOpen,
}: {
  task: TaskRecord
  now: number
  active: boolean
  onOpen: () => void
}) {
  const style = STATUS_STYLE[task.status]
  const Icon = style.icon
  const progress = taskProgress(task)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`任务：${task.title || task.goal || '未命名'}`}
      className={cn(
        'w-full rounded-sm border border-line-hairline bg-bg-raised/40 px-2.5 py-2 text-left transition-colors duration-fast hover:bg-bg-hover',
      )}
      style={active ? { borderColor: 'var(--accent-blue)' } : undefined}
    >
      <span className="flex items-start gap-1.5">
        <Icon size={13} className="mt-0.5 shrink-0" style={{ color: style.color }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg-primary">
            {task.title || task.goal || '(没有标题的任务)'}
          </span>
          <span className="mt-0.5 block truncate text-2xs text-fg-secondary">
            {currentStepOf(task)}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-fg-tertiary">
            <span>
              {progress.done}/{progress.total || 0} 步
            </span>
            <span>{task.steps.length} Tool</span>
            <span>历时 {formatDuration(elapsedMs(task, now))}</span>
            <span>更新 {formatUpdated(task.updatedAt)}</span>
          </span>
        </span>
      </span>
    </button>
  )
}
