import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ForkPoint } from '@/lib/branchPath'
import { cn } from '@/lib/utils'
import { ForkPopover } from './ForkPopover'

/* ══════════════════════════════════════════════════════════════
   路径面包屑：主干 › 提问 2 · 2/3 › 答复 1 · 1/2 › 当前

   只列**分叉点**（没分叉的路段不占位置）。点任意一段弹出那一层的
   分支菜单，选一条就切过去。没有分叉点时整条隐藏（不给界面添噪音）。
   ══════════════════════════════════════════════════════════════ */

export function BranchBreadcrumb({ forks }: { forks: ForkPoint[] }) {
  if (forks.length === 0) return null
  return (
    <nav
      aria-label="分支路径"
      data-branch-breadcrumb="true"
      className="flex items-center gap-0.5 overflow-x-auto border-b border-line-hairline px-4 py-1 text-2xs text-fg-tertiary"
    >
      <span className="shrink-0 px-0.5">主干</span>
      {forks.map((fork) => (
        <Fragment key={fork.id}>
          <ChevronRight size={11} className="shrink-0 opacity-50" />
          <ForkPopover fork={fork} side="bottom">
            {({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                title={`${fork.name}：第 ${fork.current + 1} / ${fork.total} 条分支`}
                data-branch-crumb={fork.level}
                className={cn(
                  'shrink-0 rounded-sm px-1 py-0.5 tabular-nums transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary',
                  open && 'bg-bg-hover text-fg-primary',
                )}
              >
                {fork.name} · {fork.current + 1}/{fork.total}
              </button>
            )}
          </ForkPopover>
        </Fragment>
      ))}
      <ChevronRight size={11} className="shrink-0 opacity-50" />
      <span className="shrink-0 px-0.5 text-fg-secondary">当前</span>
    </nav>
  )
}
