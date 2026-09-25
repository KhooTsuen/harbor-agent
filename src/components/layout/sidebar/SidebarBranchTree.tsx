import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, GitFork } from 'lucide-react'
import { getActiveThread, useAppStore } from '@/stores/useAppStore'
import { getForkPoints, type ForkPoint } from '@/lib/branchPath'
import { switchBranch } from '@/stores/thread/branchSwitch'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   侧栏的「分支树」（可折叠）

   只画**当前激活路径**上的分叉点（L1、L2…），每个分叉点展开显示它的
   全部兄弟分支，当前那条高亮。点别的分支 = 切过去（整条后续链跟着走，
   和面包屑是同一套动作）。

   为什么不是「整棵树的每个节点」：非激活版本的后续轮次不在内存里
   （内核只把选中版本的后续链读出来），要画全树得改内核读取口径 ——
   这一步先不做，界面呈现「当前路径 + 每个分叉的全部兄弟」。
   ══════════════════════════════════════════════════════════════ */

export function SidebarBranchTree() {
  const messages = useAppStore((s) => getActiveThread(s)?.messages)
  const forks = useMemo(() => getForkPoints(messages ?? []), [messages])
  const [open, setOpen] = useState(false)
  /** 每个分叉点自己的折叠状态 —— 默认**展开**（要看到兄弟分支） */
  const [folded, setFolded] = useState<Record<string, boolean>>({})

  return (
    <section className="border-t border-line-hairline" data-branch-tree="true">
      <button
        type="button"
        aria-expanded={open}
        aria-label="分支树"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-2xs text-fg-tertiary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
      >
        <GitFork size={13} />
        分支树
        <span className="ml-auto tabular-nums">
          {forks.length > 0 ? `${forks.length} 个分叉点` : '无分叉'}
        </span>
        <ChevronDown
          size={12}
          className={cn('transition-transform duration-fast', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="max-h-56 overflow-y-auto px-2 pb-2" role="tree" aria-label="分支树">
          {forks.length === 0 ? (
            <p className="px-1.5 py-2 text-2xs text-fg-tertiary">
              这条对话还没有分叉 —— 编辑消息或重新生成后会出现
            </p>
          ) : (
            forks.map((fork) => (
              <TreeFork
                key={fork.id}
                fork={fork}
                folded={folded[fork.id] === true}
                onToggle={() => setFolded((s) => ({ ...s, [fork.id]: !s[fork.id] }))}
              />
            ))
          )}
        </div>
      ) : null}
    </section>
  )
}

/** 一个分叉点：标题行（L 层号 + 名称 + 当前/总数）+ 展开后的兄弟分支列表 */
function TreeFork({
  fork,
  folded,
  onToggle,
}: {
  fork: ForkPoint
  folded: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex flex-col" role="treeitem" aria-expanded={!folded}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-left text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover"
      >
        {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <span className="font-mono text-fg-tertiary">L{fork.level}</span>
        <span>{fork.name}</span>
        <span className="ml-auto tabular-nums text-fg-tertiary">
          {fork.current + 1}/{fork.total}
        </span>
      </button>
      {!folded ? (
        <div className="ml-4 flex flex-col border-l border-line-hairline pl-1.5">
          {fork.options.map((option) => (
            <button
              key={option.index}
              type="button"
              role="treeitem"
              aria-current={option.current ? 'true' : undefined}
              onClick={() => {
                if (!option.current) switchBranch(fork, option.index)
              }}
              data-branch-node={option.current ? 'active' : 'idle'}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-2xs transition-colors duration-fast hover:bg-bg-hover',
                option.current ? 'bg-accent-subtle text-fg-primary' : 'text-fg-tertiary',
              )}
            >
              <span
                className={cn('size-1.5 shrink-0 rounded-full', !option.current && 'opacity-30')}
                style={{ background: 'var(--accent-blue)' }}
              />
              <span className="min-w-0 flex-1 truncate">{option.preview}</span>
              <span className="shrink-0 font-mono opacity-70">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
