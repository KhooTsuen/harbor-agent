import { Check } from 'lucide-react'
import type { Thread } from '@/types'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   批量选择时的对话列表

   进入「多选删除」后，侧栏换成这个平铺列表 —— 不带项目分组。
   多选的时候人在挑东西，不是在浏览，分组的层级反而是干扰。

   单独一个文件是因为 Sidebar 已经接近 300 行了。

   ── P3 #11 补的三件事 ────────────────────────────────────────
    ① **全选 / 取消全选**，且只作用于 `threads` 这一批（调用方传进来的
       就是当前筛选 / 搜索后的结果）—— 不隐含扩展到未展示范围。
    ② **数量显示**：已选 N / 共 M，两个数都摆出来，删之前能对得上。
    ③ **没得选时按钮禁用**（空结果下不该出现可点的「全选」）。
   ══════════════════════════════════════════════════════════════ */

export interface BulkSelectListProps {
  threads: readonly Thread[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  /** P3 #11：全选当前这批（由调用方传进来的范围决定） */
  onSelectAll: (ids: readonly string[]) => void
  /** P3 #11：取消全选 */
  onClearAll: () => void
}

export function BulkSelectList({
  threads,
  selected,
  onToggle,
  onSelectAll,
  onClearAll,
}: BulkSelectListProps) {
  const ids = threads.map((thread) => thread.id)
  /* 只统计「这批里」选中的 —— 万一有越界选择也照实按当前范围显示 */
  const chosen = ids.filter((id) => selected.has(id)).length
  const allChosen = threads.length > 0 && chosen === threads.length

  if (threads.length === 0) {
    return <p className="px-2 py-4 text-center text-2xs text-fg-tertiary">没有对话</p>
  }

  return (
    <div className="flex flex-col gap-1">
      {/* 全选 / 取消全选 + 数量 —— 放在列表上方，删之前先看清楚选了几条 */}
      <div className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-2xs text-fg-tertiary">
        <button
          type="button"
          onClick={() => (allChosen ? onClearAll() : onSelectAll(ids))}
          aria-pressed={allChosen}
          className="rounded-sm border border-line-hairline px-1.5 py-0.5 text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          {allChosen ? '取消全选' : '全选'}
        </button>
        <span className="tabular-nums" role="status">
          已选 {chosen} / 共 {threads.length}
        </span>
      </div>

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
                  {on ? <Check size={10} style={{ color: 'var(--fg-on-emphasis)' }} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate" title={thread.title}>
                  {thread.title}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
