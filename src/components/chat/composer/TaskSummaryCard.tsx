import { CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react'
import { taskSummaryOf, type SummaryTone } from '@/lib/taskSummary'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { colorOf, statusOfToast } from '@/lib/statusLanguage'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   任务结果摘要卡（P2 #30）

   **默认关闭**：`settings.taskSummary` 不是 true 时组件直接返回 null，
   一条 DOM 都不生成（不是「生成后隐藏」—— 那也叫额外生成）。

   和 `NextSteps` 的区别：
     · NextSteps = 「接下来能做什么」（只认成功、给快捷入口）
     · 这个     = 「这一轮到底成了没成」（完成 / 失败 / 停下都显示）

   两者可以同时出现，所以它排在 NextSteps 上面一行，视觉上更轻。
   ══════════════════════════════════════════════════════════════ */

const ICON: Record<SummaryTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  failed: XCircle,
  stopped: AlertTriangle,
}
const TONE_STATUS = {
  success: statusOfToast('success'),
  failed: statusOfToast('error'),
  stopped: statusOfToast('warning'),
} as const

export function TaskSummaryCard() {
  const enabled = useSettingsStore((s) => s.settings.taskSummary)
  const summary = useUIStore((s) => s.taskSummary)
  const setTaskSummary = useUIStore((s) => s.setTaskSummary)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const activeThreadId = useAppStore((s) => s.activeThreadId)

  /* 关着就什么都不生成 */
  if (!enabled) return null
  /* 只认当前这条对话 —— 切走了不显示（也不用清理，回来还在） */
  if (!summary || summary.threadId !== activeThreadId) return null

  const view = taskSummaryOf(summary.payload)
  const Icon = ICON[view.tone]
  const title = summary.payload.description.split('\n')[0]?.trim() || '这一轮'

  return (
    <section
      aria-label="任务结果摘要"
      className="mb-2 rounded-base border border-line-subtle bg-bg-raised/40 px-2.5 py-2"
    >
      <div className="flex items-start gap-2">
        <Icon
          size={13}
          className="mt-0.5 shrink-0"
          style={{ color: colorOf(TONE_STATUS[view.tone]) }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium text-fg-primary">
            {view.headline}
            <span className="ml-1.5 font-normal text-fg-tertiary">{title}</span>
          </p>
          <p className="mt-0.5 text-2xs text-fg-secondary">
            {view.facts.join(' · ')}
            <span
              className={cn(
                'ml-1.5',
                summary.payload.outcome.tests === 'failed'
                  ? 'text-danger'
                  : summary.payload.outcome.tests === 'passed'
                    ? 'text-fg-secondary'
                    : 'text-fg-tertiary',
              )}
            >
              {view.testLabel}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setTaskSummary(null)}
          aria-label="收起结果摘要"
          title="收起"
          className="shrink-0 rounded-pill p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <X size={11} />
        </button>
      </div>

      {view.hasFiles ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
          <button
            type="button"
            onClick={() => setActiveRightTab('diff')}
            className="rounded-pill border border-line-hairline px-2 py-0.5 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
          >
            查看改动的 {summary.payload.outcome.files} 个文件
          </button>
          <button
            type="button"
            onClick={() => setActiveRightTab('artifacts')}
            className="rounded-pill border border-line-hairline px-2 py-0.5 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
          >
            看成果
          </button>
        </div>
      ) : null}
    </section>
  )
}
