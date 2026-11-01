import { FolderPlus, ListChecks, Search, Trash2, X } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend } from '@/lib/backend'
import { useBulkSelect } from '@/hooks/useBulkSelect'
import { IconButton } from '@/components/ui/IconButton'

/* ══════════════════════════════════════════════════════════════
   侧栏头部：多选 / 搜索

   「⌘ Workbench」标识和折叠按钮已经上移到窗口级顶栏（AppTitleBar）——
   那是窗口级的东西，不该由侧栏自己再画一份。

   ── 2026-10-31 第二阶段：顶部两个入口搬走了 ──────────────────
   这里原来有两个按钮，都移除了：
     · 「新建对话」——它用的是 `createThread()`（跟随当前选中的文件夹），
       而侧栏里已经有三个**说得更清楚**的入口：
         「对话文件夹」标题旁的「选目录并新建」、文件夹行的 ＋、
         「单独对话」行的 ＋。同一个动作放四个地方，用户只会猜「它们一样吗」。
       ★ Ctrl+N 与折叠态那条图标**行为不变**，仍是 `createThread()`
         （= 当前选中的对话文件夹，没选中就是单独对话）。
     · 「默认工作目录…」——它是**全局默认值**，不属于侧栏。
       现在在「设置 → 对话」顶部，那里才说明得了「这是全局的」。
   浏览器预览没有真后端时仍留一个「新建项目」入口（否则预览里没处建项目）。
   ══════════════════════════════════════════════════════════════ */

export function SidebarHeader() {
  const createProject = useAppStore((s) => s.createProject)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const setSearchQuery = useUIStore((s) => s.setSearchQuery)
  const showToast = useUIStore((s) => s.showToast)
  const bulk = useBulkSelect()

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
      {!useRealBackend ? (
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('新项目名称', '')
            if (name?.trim()) {
              /* 路径留空：内核新建的项目登记项没有目录，别编一个 `~/projects/x` 的假路径
                 —— 那个假路径会被当成工作目录传给会话（真机上会去开一个不存在的目录） */
              createProject(name.trim(), '')
              showToast('success', '项目已创建', name.trim())
            }
          }}
          className="flex items-center gap-2 rounded-small px-2 py-1.5 text-dense text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <FolderPlus size={15} className="shrink-0" />
          新建项目
        </button>
      ) : null}

      {/* 多选删除 */}
      {bulk.active ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={bulk.removeSelected}
            disabled={bulk.selected.size === 0}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-small px-2 py-1.5 text-dense transition-colors hover:bg-bg-hover disabled:opacity-40"
            style={{ color: bulk.selected.size > 0 ? 'var(--error)' : undefined }}
          >
            <Trash2 size={15} className="shrink-0" />
            <span className="truncate">
              删除{bulk.selected.size > 0 ? ` ${bulk.selected.size} 条` : ''}
            </span>
          </button>
          <IconButton label="取消多选" size={28} onClick={bulk.exit}>
            <X size={13} />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          onClick={bulk.start}
          className="flex items-center gap-2 rounded-small px-2 py-1.5 text-dense text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <ListChecks size={15} className="shrink-0" />
          多选删除
        </button>
      )}

      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
        />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索对话"
          aria-label="搜索对话"
          className="w-full rounded-small border border-transparent bg-bg-raised/60 py-1.5 pl-7 pr-2 text-dense text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:bg-bg-raised focus:outline-none"
        />
      </div>
    </div>
  )
}
