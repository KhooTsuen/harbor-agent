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

      {/* 时间：悬停时也保持可见 —— 不许用悬停把信息换掉（2026-09-26 用户反馈） */}
      <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
        {relativeTime(thread.updatedAt)}
      </span>

      {/*
        操作槽：位置与占地**恒定**（w-7 × h-4），悬停只做透明度渐显。
        ⚠️ 两条红线，别再往回改：
        · 不许挂 hidden / group-hover:flex —— 那会让「悬停换内容」：时间与模式
          藏起来、按钮顶出来，鼠标扫过列表时整行右半边跳来跳去（用户报过两次）；
        · 不许让它决定行高 —— 里面的 IconButton 是 28px，比文字行高（~20px）高，
          钉 h-4 后多出来的高度上下对称溢出（行有 6px 内边距兜着，真机复核在行内）。
      */}
      <div className="flex h-4 w-7 shrink-0 items-center justify-center">
        <Popover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          side="bottom"
          align="end"
          trigger={({ toggle }) => (
            <span
              role="presentation"
              className="opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
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
        <span className="hidden shrink-0 text-2xs text-fg-tertiary lg:inline">
          {mode?.label.slice(0, 1)}
        </span>
      </Tooltip>
    </div>
  )
}
