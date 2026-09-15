import { Check } from 'lucide-react'
import type { Thread } from '@/types'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   批量选择时的对话列表

   进入「多选删除」后，侧栏换成这个平铺列表 —— 不带项目分组。
   多选的时候人在挑东西，不是在浏览，分组的层级反而是干扰。

   单独一个文件是因为 Sidebar 已经接近 300 行了。
   ══════════════════════════════════════════════════════════════ */

export interface BulkSelectListProps {
  threads: readonly Thread[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
}

export function BulkSelectList({ threads, selected, onToggle }: BulkSelectListProps) {
  if (threads.length === 0) {
    return <p className="px-2 py-4 text-center text-2xs text-fg-tertiary">没有对话</p>
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2" aria-label="选择要删除的对话">
      {threads.map((thread) => {
        const on = selected.has(thread.id)
        return (
          <li key={thread.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onToggle(thread.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-small px-2 py-1.5 text-left text-dense transition-colors duration-fast',
                on
                  ? 'bg-bg-raised text-fg-primary'
                  : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
              )}
            >
              <span
                className={cn(
                  'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                  on ? 'border-transparent' : 'border-line-strong',
                )}
                style={on ? { background: 'var(--accent-blue)' } : undefined}
                aria-hidden="true"
              >
                {on ? <Check size={10} style={{ color: '#fff' }} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate" title={thread.title}>
                {thread.title}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
