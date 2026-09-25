import { GitFork } from 'lucide-react'
import type { ForkPoint } from '@/lib/branchPath'
import { ForkPopover } from './ForkPopover'

/* ══════════════════════════════════════════════════════════════
   消息旁的层级指示器：⑂ L2 · 3

   说明「这里是第几层分叉、这个位置有几条分支」。点开就是这一层的
   全部分支（和面包屑同一个菜单）—— 切过去只换这一层，整条后续链
   按既有机制跟着走（提问版会重读、回答版只换显示）。
   ══════════════════════════════════════════════════════════════ */

export function ForkBadge({ fork }: { fork: ForkPoint }) {
  return (
    <ForkPopover fork={fork} side="top">
      {({ open, toggle }) => (
        <button
          type="button"
          aria-label={`分支 L${fork.level}`}
          aria-expanded={open}
          title={`第 ${fork.level} 层分叉：这个位置有 ${fork.total} 条分支`}
          onClick={toggle}
          data-fork-badge={fork.level}
          className="flex items-center gap-0.5 rounded-sm px-1 py-0.5 tabular-nums text-2xs text-accent transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          <GitFork size={11} />L{fork.level} · {fork.total}
        </button>
      )}
    </ForkPopover>
  )
}
