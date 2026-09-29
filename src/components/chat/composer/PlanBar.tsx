import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Circle } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { useTaskStore } from '@/stores/useTaskStore'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'
import { cleanPlanLine, isPlanDone } from '../taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   计划栏 —— 与输入框嵌合（2026-09-30 用户要求）

   以前计划是**正文里的一个代码块**（模型写 ```plan），画出来是一张大卡片，
   插在「思考 / 工具 / 正文」中间，把顺序感打断。

   现在：
     · 正文里**不再画**那个块（见 `markdown/Blocks.tsx`）
     · 计划改成输入框上方/下方这一条：**没有计划就完全不出现**
     · 折叠 → 只显示「正在做的那一步」；展开 → 最多 4 条 + 「还有 N 条」
   数据来自任务台账（内核已经在解析 plan，前端不再自己从正文里抠）。
   ══════════════════════════════════════════════════════════════ */

/** 展开时最多显示几条（用户要求：完全显示最多 4 个计划） */
const MAX_VISIBLE = 4

export function PlanBar({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  const tasks = useTaskStore((s) => s.tasks)

  /* 这条对话最近动过的那个任务 —— 计划跟着它走 */
  const latest = tasks
    .filter((task) => task.sessionId === threadId)
    .reduce<TaskRecord | null>(
      (best, task) => (!best || task.updatedAt > best.updatedAt ? task : best),
      null,
    )
  const plan = latest?.plan ?? []
  /* 没有计划就一行都不占（用户要求：检测有才显示） */
  if (plan.length === 0) return null

  const done = plan.filter(isPlanDone).length
  const currentIndex = plan.findIndex((line) => !isPlanDone(line))
  const current = currentIndex >= 0 ? plan[currentIndex] : ''
  const shown = open ? plan.slice(0, MAX_VISIBLE) : []
  const rest = plan.length - shown.length

  return (
    <div className="mb-1.5 rounded-sm border border-line-subtle bg-bg-raised/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs transition-colors duration-fast hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        <span className="shrink-0 text-fg-secondary">
          计划 · {done}/{plan.length}
        </span>
        {open ? (
          <span className="flex-1" />
        ) : (
          /* 折叠时：正在进行的那一步（做完则说一句「全部完成」） */
          <span className="min-w-0 flex-1 truncate text-fg-tertiary">
            {current ? `正在做：${cleanPlanLine(current)}` : '全部完成'}
          </span>
        )}
        {open && rest > 0 ? <span className="shrink-0 text-fg-tertiary">还有 {rest} 条</span> : null}
      </button>

      {open ? (
        <ul className="flex flex-col gap-0.5 px-2 pb-1.5">
          {shown.map((line, index) => {
            const isCurrent = index === currentIndex
            return (
              <li
                key={index}
                className={cn(
                  'flex items-start gap-1.5 text-2xs',
                  isCurrent ? 'text-fg-primary' : 'text-fg-secondary',
                )}
              >
                {isPlanDone(line) ? (
                  <CheckCircle2
                    size={11}
                    className={cn('mt-0.5 shrink-0', STATUS_CLASS.completed.text)}
                  />
                ) : isCurrent ? (
                  <Circle
                    size={11}
                    className="mt-0.5 shrink-0 text-accent"
                    style={{ fill: 'currentColor' }}
                  />
                ) : (
                  <Circle size={11} className="mt-0.5 shrink-0 text-fg-tertiary" />
                )}
                <span className="min-w-0">{cleanPlanLine(line)}</span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
