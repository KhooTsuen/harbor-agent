import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import type { Project, Thread } from '@/types'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem, Popover } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'
import { ThreadRow } from './ThreadRow'

/* ══════════════════════════════════════════════════════════════
   侧栏里的项目分组

   标题行：折叠箭头、文件夹图标、项目名、线程数、悬停出现的新建按钮和菜单。
   菜单：重命名 / 固定 / 归档 / 删除（删除二次确认）。
   ══════════════════════════════════════════════════════════════ */

export interface ProjectGroupProps {
  project: Project
  threads: Thread[]
  onDeleteThread: (thread: Thread) => void
  collapsed: boolean
}

export function ProjectGroup({ project, threads, onDeleteThread, collapsed }: ProjectGroupProps) {
  const [open, setOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(project.name)

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const createThread = useAppStore((s) => s.createThread)
  const renameProject = useAppStore((s) => s.renameProject)
  const togglePinProject = useAppStore((s) => s.togglePinProject)
  const toggleArchiveProject = useAppStore((s) => s.toggleArchiveProject)
  const deleteProject = useAppStore((s) => s.deleteProject)
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  const hasActive = threads.some((t) => t.id === activeThreadId)

  function commitRename(): void {
    renameProject(project.id, draft)
    setRenaming(false)
  }

  if (renaming) {
    return (
      <div className="px-2 py-0.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              setDraft(project.name)
              setRenaming(false)
            }
          }}
          aria-label="重命名项目"
          className="w-full rounded-small border border-line-focus bg-bg-raised px-2 py-1 text-xs font-medium text-fg-primary outline-none"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-small px-2 py-1.5 transition-colors',
          hasActive ? 'text-fg-primary' : 'text-fg-secondary hover:bg-bg-hover',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? '折叠项目' : '展开项目'}
          className="shrink-0 rounded-small p-0.5 text-fg-tertiary hover:text-fg-primary"
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <FolderClosed size={13} className="shrink-0 text-fg-tertiary" />

        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={project.path}>
          {project.pinned ? (
            <Pin size={10} className="mr-0.5 inline-block text-fg-tertiary" />
          ) : null}
          {project.name}
        </span>

        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{threads.length}</span>

        <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
          <Tooltip content="在这个项目里新建线程">
            <IconButton label="新建线程" size={28} onClick={() => createThread(project.id)}>
              <MessageSquarePlus size={13} />
            </IconButton>
          </Tooltip>

          <Popover
            open={menuOpen}
            onOpenChange={setMenuOpen}
            side="bottom"
            align="end"
            trigger={({ toggle }) => (
              <span
                role="presentation"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle()
                }}
              >
                <IconButton label="项目菜单" size={28}>
                  <MoreHorizontal size={14} />
                </IconButton>
              </span>
            )}
          >
            <MenuItem
              icon={<Pencil size={13} />}
              onSelect={() => {
                setDraft(project.name)
                setRenaming(true)
                setMenuOpen(false)
              }}
            >
              重命名
            </MenuItem>
            <MenuItem
              icon={project.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              onSelect={() => {
                togglePinProject(project.id)
                setMenuOpen(false)
              }}
            >
              {project.pinned ? '取消置顶' : '置顶'}
            </MenuItem>
            <MenuItem
              icon={project.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              onSelect={() => {
                toggleArchiveProject(project.id)
                setMenuOpen(false)
              }}
            >
              {project.archived ? '取消归档' : '归档'}
            </MenuItem>
            <MenuItem
              icon={<Trash2 size={13} />}
              onSelect={() => {
                setMenuOpen(false)
                askPermission({
                  kind: 'delete-project',
                  title: '删除这个项目？',
                  description: `「${project.name}」下的 ${threads.length} 条对话会一起删掉，不能撤销。`,
                  confirmText: '删除',
                  danger: true,
                  onConfirm: () => {
                    deleteProject(project.id)
                    showToast('success', '项目已删除')
                  },
                })
              }}
            >
              删除项目
            </MenuItem>
          </Popover>
        </div>
      </div>

      {open && !collapsed ? (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-line-hairline pl-1">
          {threads.length === 0 ? (
            <p className="px-2 py-1.5 text-2xs text-fg-tertiary">暂无对话</p>
          ) : (
            threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} onDelete={() => onDeleteThread(thread)} />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
