import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { ProgressTimeline } from './ProgressTimeline'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   任务列表（AG-011）

   补的是两个记了很久的洞：

     ① AG-005 ——「时间线只在有未完成任务时可见，任务一结束就跟着消失，
        事后想回看进度看不到」
     ② AG-009 ——「项目没有独立的任务页面，『查看任务』只验到右栏状态标签」

   所以这里就放在右栏的「状态」里：**当前这条对话的全部任务**（含已完成的），
   点一条展开它的时间线。不新建页面 —— 用户看任务的时机基本就是
   「我刚让它干了什么」，那一刻右栏本来就开着。

   ★ 不做的事：不改任务的生命周期。这里只读（task:list 老接口）——
     开始/继续/放弃只在右栏的「任务」标签（AG-028 的任务中心）里。
   ══════════════════════════════════════════════════════════════ */

const STATUS_TEXT: Record<TaskRecord['status'], string> = {
  running: '进行中',
  waiting_user: '等你确认',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已放弃',
}

/** 完成/失败/放弃都算「已经结束」，颜色淡一档 */
const SETTLED: TaskRecord['status'][] = ['completed', 'failed', 'cancelled']

function when(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function TaskList() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const phases = useAppStore(
    (s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.phaseHistory ?? [],
  )
  const allTasks = useTaskStore((s) => s.tasks)
  const refresh = useTaskStore((s) => s.refresh)
  const [openId, setOpenId] = useState('')

  /* AG-028：不再自己拉 task:list；状态页和全局任务中心共用同一份 store 快照。 */
  useEffect(() => {
    void refresh()
  }, [refresh])

  const tasks = useMemo(
    () => allTasks.filter((task) => task.sessionId === activeThreadId).slice(0, 20),
    [activeThreadId, allTasks],
  )

  if (tasks.length === 0) {
    return <p className="text-xs text-fg-tertiary">还没有任务记录。</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {tasks.map((task) => {
        const open = openId === task.id
        const settled = SETTLED.includes(task.status)
        return (
          <div key={task.id} className="rounded-sm border border-line-hairline bg-bg-raised/40">
            <button
              type="button"
              onClick={() => setOpenId(open ? '' : task.id)}
              aria-expanded={open}
              aria-label={`任务：${task.title || task.goal || '未命名'}`}
              className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left transition-colors duration-fast hover:bg-bg-raised"
            >
              {open ? (
                <ChevronDown size={12} className="mt-0.5 shrink-0 text-fg-tertiary" />
              ) : (
                <ChevronRight size={12} className="mt-0.5 shrink-0 text-fg-tertiary" />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-xs',
                    settled ? 'text-fg-secondary' : 'text-fg-primary',
                  )}
                >
                  {task.title || task.goal || '(没有标题的任务)'}
                </span>
                <span className="mt-0.5 block text-2xs text-fg-tertiary">
                  {STATUS_TEXT[task.status] ?? task.status} · {task.steps.length} 步 · 改了{' '}
                  {task.changedFiles.length} 个文件
                  {task.updatedAt ? ` · ${when(task.updatedAt)}` : ''}
                </span>
              </span>
            </button>

            {open ? (
              <div className="border-t border-line-hairline px-2 pb-2">
                <ProgressTimeline phases={phases ?? []} steps={task.steps} plan={task.plan} />
                {task.result ? (
                  <p className="mt-2 whitespace-pre-wrap text-2xs text-fg-tertiary">
                    {task.result}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
