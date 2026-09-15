import {
  FolderPlus,
  ListChecks,
  MessageSquarePlus,
  PanelLeftClose,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend } from '@/lib/backend'
import { useBulkSelect } from '@/hooks/useBulkSelect'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'

/* ══════════════════════════════════════════════════════════════
   侧栏头部：标题 / 折叠 / 新建 / 切换目录 / 多选 / 搜索

   从 Sidebar.tsx 拆出来的 —— 那边加了「上下两栏 + 分隔线」之后过 300 行。
   这一段只管「用户想干什么」的入口，和列表怎么排没关系。
   ══════════════════════════════════════════════════════════════ */

export function SidebarHeader() {
  const createThread = useAppStore((s) => s.createThread)
  const createProject = useAppStore((s) => s.createProject)
  const chooseWorkdir = useConfigStore((s) => s.chooseWorkdir)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const setSearchQuery = useUIStore((s) => s.setSearchQuery)
  const showToast = useUIStore((s) => s.showToast)
  const bulk = useBulkSelect()

  return (
    <>
      {/* 头部 */}
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2.5">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-small bg-bg-raised font-mono text-2xs font-semibold text-fg-primary"
        >
          ⌘
        </span>
        <span className="min-w-0 flex-1 truncate text-dense font-semibold text-fg-primary">
          Workbench
        </span>
        <Tooltip content="折叠侧边栏（Ctrl+B）">
          <IconButton label="折叠侧边栏" onClick={() => updateSettings({ sidebarCollapsed: true })}>
            <PanelLeftClose size={15} />
          </IconButton>
        </Tooltip>
      </div>

      {/* 新建 + 搜索 */}
      <div className="flex flex-col gap-0.5 px-2 pb-2">
        <button
          type="button"
          onClick={() => createThread()}
          className="flex items-center gap-2 rounded-small px-2 py-1.5 text-dense text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <MessageSquarePlus size={15} className="shrink-0" />
          新建对话
          <span className="ml-auto font-mono text-2xs text-fg-tertiary">Ctrl N</span>
        </button>

        <button
          type="button"
          onClick={() => {
            if (useRealBackend) {
              void chooseWorkdir().then((ok) => {
                if (ok) showToast('success', '已切换工作目录')
              })
            } else {
              const name = window.prompt('新项目名称', '')
              if (name?.trim()) {
                createProject(name.trim(), `~/projects/${name.trim()}`)
                showToast('success', '项目已创建', name.trim())
              }
            }
          }}
          className="flex items-center gap-2 rounded-small px-2 py-1.5 text-dense text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <FolderPlus size={15} className="shrink-0" />
          {useRealBackend ? '默认工作目录…' : '新建项目'}
        </button>

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
    </>
  )
}
