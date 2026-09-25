import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Trash2,
  FolderMinus,
  FolderPlus,
} from 'lucide-react'
import type { Thread } from '@/types'
import { cn, relativeTime } from '@/lib/utils'
import { MODES } from '@/constants'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { threadToMarkdown } from '@/lib/export'
import { saveText } from '@/lib/backend'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem, Popover } from '@/components/ui/Popover'
import { StatusDot } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'
import { useThreadHasTask } from '@/stores/useTaskStore'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   侧栏里的一行线程

   三种状态挤在一行里：
     · 平时：状态点 + 标题 +「多久前」+ 模式首字
     · 悬停：时间换成操作菜单按钮
     · 重命名：整行变成输入框
   ══════════════════════════════════════════════════════════════ */

export interface ThreadRowProps {
  thread: Thread
  onDelete: () => void
  /** 把这条对话挂到一个目录（弹目录选择框） */
  onMoveToFolder?: () => void
  /** 摘掉文件夹，变成单独对话 */
  onDetachFolder?: () => void
}

export function ThreadRow({ thread, onDelete, onMoveToFolder, onDetachFolder }: ThreadRowProps) {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const renameThread = useAppStore((s) => s.renameThread)
  const togglePinThread = useAppStore((s) => s.togglePinThread)
  const toggleArchiveThread = useAppStore((s) => s.toggleArchiveThread)
  const addThreadTag = useAppStore((s) => s.addThreadTag)
  const markThreadExported = useAppStore((s) => s.markThreadExported)
  const showToast = useUIStore((s) => s.showToast)
  /* 这条对话有没干完的任务 → 挂个黄点（别的地方不再乱弹横幅） */
  const hasUnfinishedTask = useThreadHasTask(thread.id)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(thread.title)

  const active = thread.id === activeThreadId
  const mode = MODES.find((m) => m.id === thread.mode)

  function commitRename(): void {
    renameThread(thread.id, draft)
    setRenaming(false)
  }

  async function exportThread(): Promise<void> {
    setMenuOpen(false)
    const result = await saveText(`${thread.title}.md`, threadToMarkdown(thread))
    if (result.ok) {
      markThreadExported(thread.id)
      showToast('success', '已导出', result.path ?? 'Markdown')
    } else if (!result.canceled) {
      showToast('error', '导出失败', result.error)
    }
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
              setDraft(thread.title)
              setRenaming(false)
            }
          }}
          aria-label="重命名线程"
          className="w-full rounded-small border border-line-focus bg-bg-input px-2 py-1 text-dense text-fg-primary outline-none"
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-xs rounded-small px-2 py-1.5',
        'cursor-pointer transition-colors duration-fast',
        active ? 'bg-accent-subtle text-fg-primary' : 'text-fg-secondary hover:bg-bg-hover',
      )}
      onClick={() => setActiveThread(thread.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setActiveThread(thread.id)
        }
      }}
      aria-current={active}
    >
      {/* 选中态的左侧指示条 */}
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-1 left-0 w-0.5 rounded-pill bg-fg-primary"
        />
      ) : null}

      <StatusDot phase={thread.phase} size={7} />

      {/*
        有没干完的任务 → 黄点。
        以前是每切到一条对话就在顶部弹个横幅，不管那任务是不是这条对话的 ——
        现在改成「侧栏一眼看是哪条」，只在那条对话里才弹详情。
      */}
      {hasUnfinishedTask ? (
        <Tooltip content="有没干完的任务">
          <span
            aria-label="有没干完的任务"
            className="inline-block size-1.5 shrink-0 rounded-full"
            style={{ background: colorOf('warning') }}
          />
        </Tooltip>
      ) : null}

      <span className="min-w-0 flex-1 truncate text-dense" title={thread.title}>
        {thread.pinned ? (
          <Pin size={11} className="mr-1 inline-block shrink-0 text-fg-tertiary" />
        ) : null}
        {thread.title}
        {thread.tags.length > 0 ? (
          <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle">
            {thread.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="rounded-small border border-line-hairline px-1 py-px font-mono text-2xs text-fg-tertiary"
              >
                {tag}
              </span>
            ))}
            {thread.tags.length > 2 ? (
              <span className="font-mono text-2xs text-fg-tertiary">+{thread.tags.length - 2}</span>
            ) : null}
          </span>
        ) : null}
      </span>

      <span className="shrink-0 font-mono text-2xs text-fg-tertiary group-hover:hidden">
        {relativeTime(thread.updatedAt)}
      </span>

      {/*
        悬停才出现的操作槽。
        ⚠️ h-4 + items-center 不是装饰，是防「悬停行变高」的：里面的 IconButton
        是 28px，比本行的文字行高（text-dense 14px × 1.43 ≈ 20px）高 —— 让它
        照常参与布局，悬停时行会从 32px 涨到 40px（真机 212×32 → 212×40 量过），
        鼠标扫过整片列表会一跳一跳。钉成 1rem 后它不再决定行高，
        按钮多出来的高度上下对称溢出（行有 6px 内边距兜着，探针复核仍在行内）。
      */}
      <div className="hidden h-4 shrink-0 items-center group-hover:flex group-focus-within:flex">
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
              <IconButton label="更多操作" size={28}>
                <MoreHorizontal size={14} />
              </IconButton>
            </span>
          )}
        >
          <MenuItem
            icon={<Pencil size={13} />}
            onSelect={() => {
              setDraft(thread.title)
              setRenaming(true)
              setMenuOpen(false)
            }}
          >
            重命名
          </MenuItem>
          <MenuItem
            icon={thread.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            onSelect={() => {
              togglePinThread(thread.id)
              setMenuOpen(false)
            }}
          >
            {thread.pinned ? '取消固定' : '固定到顶部'}
          </MenuItem>
          {onMoveToFolder ? (
            <MenuItem
              icon={<FolderPlus size={13} />}
              onSelect={() => {
                onMoveToFolder()
                setMenuOpen(false)
              }}
            >
              {thread.workdir ? '换个文件夹…' : '移到文件夹…'}
            </MenuItem>
          ) : null}
          {thread.workdir && onDetachFolder ? (
            <MenuItem
              icon={<FolderMinus size={13} />}
              onSelect={() => {
                onDetachFolder()
                setMenuOpen(false)
              }}
            >
              移出文件夹（变成单独对话）
            </MenuItem>
          ) : null}
          <MenuItem icon={<Download size={13} />} onSelect={() => void exportThread()}>
            导出 Markdown
          </MenuItem>
          <MenuItem
            icon={thread.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            onSelect={() => {
              toggleArchiveThread(thread.id)
              setMenuOpen(false)
            }}
          >
            {thread.archived ? '取消归档' : '归档'}
          </MenuItem>
          <MenuItem
            icon={<Tag size={13} />}
            onSelect={() => {
              const tag = window.prompt('加一个标签（如 bug / feature / refactor）', '')
              if (tag?.trim()) addThreadTag(thread.id, tag.trim())
              setMenuOpen(false)
            }}
          >
            加标签
          </MenuItem>
          <MenuItem
            icon={<Trash2 size={13} />}
            onSelect={() => {
              setMenuOpen(false)
              onDelete()
            }}
          >
            删除
          </MenuItem>
        </Popover>
      </div>

      <Tooltip content={mode ? `模式：${mode.label}` : '模式'} side="right">
        <span className="hidden shrink-0 text-2xs text-fg-tertiary group-hover:hidden lg:inline">
          {mode?.label.slice(0, 1)}
        </span>
      </Tooltip>
    </div>
  )
}
