import { CircleDot } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'

/**
 * 任务中心的空状态。
 *
 * 从 TaskCenter.tsx 抽出来的（那边贴到 300 行上限了）。
 *
 * 为什么要带那个「看全部项目」出口：默认只看当前项目，而**标题栏上的开关这时候
 * 不渲染**（空状态不画标题栏）—— 不给出口的话，「别的项目跑过什么」就没地方发现了。
 */
export function TaskCenterEmpty({
  scope,
  onShowAll,
}: {
  scope: 'project' | 'all'
  onShowAll: () => void
}) {
  return (
    <div
      aria-label="任务中心"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2"
    >
      <EmptyState
        icon={<CircleDot size={28} />}
        title={scope === 'all' ? '还没有后台任务' : '这个项目还没有后台任务'}
        description="让 Agent 做一件事后，运行状态、当前步骤和结果会集中显示在这里。"
      />
      {scope === 'project' ? (
        <button
          type="button"
          onClick={onShowAll}
          aria-label="看全部项目"
          className="rounded-sm px-1.5 text-2xs text-fg-tertiary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          看全部项目
        </button>
      ) : null}
    </div>
  )
}
