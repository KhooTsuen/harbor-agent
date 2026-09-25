import { useState, type ReactNode } from 'react'
import type { ForkPoint } from '@/lib/branchPath'
import { switchBranch } from '@/stores/thread/branchSwitch'
import { Popover, type PopoverSide } from '@/components/ui/Popover'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   分叉菜单：某个分叉点的全部兄弟分支（点一条就切过去）

   面包屑、消息旁的 L 标、都用它当弹层内容 —— 一处渲染，三处复用。
   选完自动关；点「当前」那条不动作（免得白写一遍盘）。
   ══════════════════════════════════════════════════════════════ */

export function ForkPopover({
  fork,
  side = 'top',
  align = 'start',
  children,
}: {
  fork: ForkPoint
  side?: PopoverSide
  align?: 'start' | 'end'
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align={align}
      trigger={children}
      className="w-80"
    >
      <ForkMenuList
        fork={fork}
        onPick={(index) => {
          setOpen(false)
          if (index !== fork.current) switchBranch(fork, index)
        }}
      />
    </Popover>
  )
}

/** 菜单里的分支列表（单独导出是为了测试能直接渲染） */
export function ForkMenuList({
  fork,
  onPick,
}: {
  fork: ForkPoint
  onPick: (index: number) => void
}) {
  return (
    <div
      className="flex max-h-72 flex-col overflow-y-auto p-1"
      role="menu"
      aria-label={`${fork.name}的 ${fork.total} 条分支`}
      data-fork-menu={fork.level}
    >
      {fork.options.map((option) => (
        <button
          key={option.index}
          type="button"
          role="menuitem"
          onClick={() => onPick(option.index)}
          className={cn(
            'flex items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-bg-hover',
            option.current ? 'bg-bg-hover/60 text-fg-primary' : 'text-fg-secondary',
          )}
        >
          <span className="w-10 shrink-0 pt-0.5 font-mono text-2xs text-fg-tertiary">
            {option.label}
          </span>
          <span className="min-w-0 flex-1 break-words">{option.preview}</span>
          {option.current ? (
            <span className="shrink-0 text-2xs" style={{ color: 'var(--accent-blue)' }}>
              当前
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
