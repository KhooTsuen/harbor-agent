import type { TaskRecord } from '@/types/safety'

export const TASK_GROUPS: ReadonlyArray<{
  status: TaskRecord['status']
  label: string
}> = [
  { status: 'running', label: '进行中' },
  { status: 'paused', label: '已暂停' },
  { status: 'waiting_user', label: '等待中' },
  { status: 'failed', label: '失败' },
  { status: 'completed', label: '已完成' },
  { status: 'cancelled', label: '已取消' },
]

export function isPlanDone(line: string): boolean {
  return /^\s*\[[xX]\]/.test(String(line))
}

export function cleanPlanLine(line: string): string {
  return String(line)
    .replace(/^\s*\[[xX ]\]\s*/, '')
    .trim()
}

export function taskProgress(task: TaskRecord): { done: number; total: number } {
  const plan = task.plan ?? []
  return { done: plan.filter(isPlanDone).length, total: plan.length }
}

/** 任务中心那行「当前步骤」；已结束任务改说结果，不假装还有当前步骤。 */
export function currentStepOf(task: TaskRecord): string {
  const pending = (task.plan ?? []).find((line) => !isPlanDone(line))
  if (pending) return cleanPlanLine(pending)
  if (task.nextAction) return cleanPlanLine(task.nextAction)

  if (task.status === 'completed') return '全部计划已完成'
  if (task.status === 'cancelled') return '任务已取消'
  if (task.status === 'failed') {
    return task.errors.at(-1)?.message || '执行失败'
  }
  const recent = task.steps.at(-1)?.summary
  return recent || '等待下一步'
}

/** 墙上经过时间：运行中走当前时钟，结束/暂停后停在最后更新时间。 */
export function elapsedMs(task: TaskRecord, now: number): number {
  const end =
    task.status === 'running' ? now : task.finishedAt || task.pausedAt || task.updatedAt || now
  return Math.max(0, end - task.createdAt)
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}时 ${String(minutes).padStart(2, '0')}分`
  if (minutes > 0) return `${minutes}分 ${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

export function formatUpdated(ms: number): string {
  if (!ms) return '未知'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function groupTasks(tasks: TaskRecord[]): Map<TaskRecord['status'], TaskRecord[]> {
  const groups = new Map<TaskRecord['status'], TaskRecord[]>()
  for (const group of TASK_GROUPS) groups.set(group.status, [])
  for (const task of tasks) groups.get(task.status)?.push(task)
  return groups
}
