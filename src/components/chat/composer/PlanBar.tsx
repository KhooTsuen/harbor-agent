import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Circle } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { useTaskStore } from '@/stores/useTaskStore'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'
import {
  cleanPlanLine,
  execMetaLabel,
  execSummary,
  isPlanDone,
  PROGRESS_TITLE,
} from '../taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   计划栏 —— 与输入框嵌合（2026-09-30 用户要求）

   以前计划是**正文里的一个代码块**（模型写 ```plan），画出来是一张大卡片，
   插在「思考 / 工具 / 正文」中间，把顺序感打断。

   现在：
     · 正文里**不再画**那个块（见 `markdown/Blocks.tsx`）
     · 计划改成输入框上方/下方这一条：**没有计划就完全不出现**
     · 折叠 → 只显示「正在做的那一步」；展开 → 整份计划都摆出来，
       长了就在卡片里滚（见下面 MAX_H_CLASS 那段注释）
   数据来自任务台账（内核已经在解析 plan，前端不再自己从正文里抠）。
   ══════════════════════════════════════════════════════════ */

/*
 * 展开时的上限 + 自己能滚（2026-10-03 用户报的：**计划卡超过 4 条后不能往下滚**）。
 *
 * 以前是硬截 `plan.slice(0, 4)` + 「还有 N 条」—— 第 5 条之后**根本看不见**，
 * 用户只能去后台任务里查「到哪一步了」。改成给一个 max-height 让它自己滚：
 *   · `max-h-24`（6rem ≈ 6 行）—— 4 条的短计划照旧全显示，更长的滚起来
 *   · `overscroll-contain` —— 滚到底不要把事件传给外面的对话列表；
 *     对话列表的 FOLLOW/FREE 滚动逻辑一行都没动（那是另一块，别混）
 *   · 滚动条不另写样式：沿用全局那套（index.css 的 ::-webkit-scrollbar，细、透明轨道）
 */
const MAX_H_CLASS = 'max-h-24 overflow-y-auto overscroll-contain'

export function PlanBar({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  const tasks = useTaskStore((s) => s.tasks)

  /*
   * 计划跟着「本会话最近一条**有计划**的任务」走。
   *
   * 2026-10-08 用户报「计划卡又不显示了」：内核每收到一句新话就新建一条任务
   * （`task-resume.cjs`，只有「继续/接着做」才复用旧的），新建的自然是空任务。
   * 以前按 updatedAt 取最新 —— 用户一开口，最新那条变成空任务，卡立刻被顶掉。
   * 所以这里跳过没计划的任务：卡只会在「更近的一条也有计划」时被换掉。
   */
  const latest = tasks
    .filter((task) => task.sessionId === threadId && (task.plan?.length ?? 0) > 0)
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
  /*
   * 动态执行摘要（2026-10-13）：与计划卡同一份事实、同一处措辞（`execMetaLabel`）。
   * 这是用户**实际常盯着**「0/5」的位点 —— 计划卡藏在任务详情里默认收起。
   * `steps === 0` → 空串 → 那一小段不渲染（不显示「已执行 0 步」）。
   */
  const execText = latest ? execMetaLabel(execSummary(latest)) : ''

  return (
    <div className="mb-1.5 rounded-sm border border-line-subtle bg-bg-raised/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        /* 悬停给口径说明（窄屏动态段被收起时的兜底提示） */
        title={PROGRESS_TITLE}
        /*
         * `overflow-hidden`：这一行**永远不许撑破**输入框旁的布局 ——
         * 子项再怎么长，也只能在这个盒子里被裁掉，不许溢出到卡片外。
         */
        className="flex w-full items-center gap-1.5 overflow-hidden px-2 py-1 text-left text-2xs transition-colors duration-fast hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        <span className="shrink-0 text-fg-secondary">
          计划 · {done}/{plan.length}
        </span>
        {execText ? (
          /*
           * ★ 窄窗口降级（用户 2026-10-13 要求）：动态执行段在**窄屏自动隐藏**，
           *   内容仍可通过这一行的 `title` 悬停看到 —— 绝不能因为多这段文案而撑破布局。
           *
           * 三重保险，缺一不可：
           *   · `hidden … min-[420px]:inline` —— 视口 < 420px（含 320px）时**整段隐藏**；
           *   · `min-w-0 truncate` —— 显示时也能**自己缩到自己截断**（省略号），不挤别人；
           *   · 外层按钮的 `overflow-hidden` —— 兜底，任何情况下都不溢出卡片。
           * `tabular-nums` 与计划卡同口径：位数变化不左右跳。
           */
          <span
            className="hidden min-w-0 truncate text-fg-tertiary tabular-nums min-[420px]:inline"
            title={PROGRESS_TITLE}
          >
            · {execText}
          </span>
        ) : null}
        {open ? (
          <span className="flex-1" />
        ) : (
          /* 折叠时：正在进行的那一步（做完则说一句「全部完成」） */
          <span className="min-w-0 flex-1 truncate text-fg-tertiary">
            {current ? `正在做：${cleanPlanLine(current)}` : '全部完成'}
          </span>
        )}
      </button>

      {open ? (
        <ul className={cn('flex flex-col gap-0.5 px-2 pb-1.5 pr-1', MAX_H_CLASS)}>
          {plan.map((line, index) => {
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
