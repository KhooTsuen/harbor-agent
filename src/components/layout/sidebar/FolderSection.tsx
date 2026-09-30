import { useState } from 'react'
import { ChevronDown, FileText, FolderClosed, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { Thread } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { folderAccentOf, folderHoverTitle, folderPathHint } from '@/constants/folders'
import { projectRulesOpen } from '@/lib/projectRulesApi'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { MenuItem, Popover } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'
import { ThreadRow } from './ThreadRow'

/* ══════════════════════════════════════════════════════════════
   侧栏里的一个「对话文件夹」：标题 + 它下面的对话

   从 `SidebarPanes.tsx` 拆出来的 —— 那边加了菜单就贴到 300 行红线了。
   拆的时候**一个字都没改**，只加了行末那个菜单（重命名/删除）。踩过的坑：
   拆分最容易的不是漏函数，而是「接线看起来通了、内容其实掉了」，所以
   搬完立刻真跑了一遍侧栏（见交付报告）。

   ── 菜单里那一项为什么叫「删除文件夹」而不是「移除」 ──
   用户 2026-09-29 报「对话文件夹也没有删除功能」，并明确选了
   **「连对话一起删掉」**。所以确认框必须把「删几条对话」写在最前面 ——
   以前 `ProjectGroup` 那套「移除项目、对话都保留」是另一种语义，两者不能混。
   磁盘上那个目录一个字节都不动（见 `store.deleteFolder`）。
   ══════════════════════════════════════════════════════════════ */

export interface FolderSectionProps {
  project: { id: string; name: string; path: string; color?: string }
  threads: Thread[]
  onDeleteThread: (thread: Thread) => void
  onMoveThread: (thread: Thread) => void
  onDetachThread: (thread: Thread) => void
  onNewThread: () => void
}

export function FolderSection({
  project,
  threads,
  onDeleteThread,
  onMoveThread,
  onDetachThread,
  onNewThread,
}: FolderSectionProps) {
  const [open, setOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const deleteFolder = useAppStore((s) => s.deleteFolder)
  const allThreads = useAppStore((s) => s.threads)
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  /*
   * 身份：颜色（扫一眼认出来）+ 路径（真正的身份，同名目录只能靠它分）。
   * 项目里自己设过色就用它，否则按目录算一个稳定色（见 constants/folders.ts）。
   */
  const accent = project.color || folderAccentOf(project.id)
  const pathHint = folderPathHint(project.path)
  /* 悬停给「名字 + 路径」：侧栏一窄名字就被省略号截掉，只给路径的话名字就没处读了 */
  const hoverTitle = folderHoverTitle(project.name, project.path)

  /*
   * ★ 数的是**全部**（含已归档），不是上面渲染出来的那几条：
   *   删除会连归档的一起删，只数看得见的，确认框里的数字就比实际删掉的少 ——
   *   而用户正是靠这个数字决定要不要按确认。
   */
  const owned = allThreads.filter((t) => t.projectId === project.id).length

  function confirmDelete(): void {
    setMenuOpen(false)
    askPermission({
      kind: 'delete-project',
      title: '删除这个对话文件夹？',
      description:
        owned > 0
          ? `「${project.name}」里的 ${owned} 条对话和它们的任务记录会一起删掉，不能撤销。磁盘上那个目录里的文件一个都不动。`
          : `「${project.name}」会从侧栏消失（它现在没有对话）。磁盘上那个目录一个都不动。`,
      confirmText: '删除',
      danger: true,
      onConfirm: () => {
        void (async () => {
          const removed = await deleteFolder(project.id)
          showToast(
            'success',
            '已删除文件夹',
            removed > 0 ? `${project.name} · 一并删掉 ${removed} 条对话` : project.name,
          )
        })()
      },
    })
  }

  /*
   * 编辑项目规则：打开**这个文件夹那个目录**里的 `.harbor/rules.md`；
   * 没有就先按骨架建一个（只读加载永远不建文件，建文件只发生在这一下点击之后）。
   */
  function editRules(): void {
    setMenuOpen(false)
    void (async () => {
      const result = await projectRulesOpen(project.path, true)
      if (!result?.ok) showToast('error', '打不开项目规则', result?.error || '内核没响应')
    })()
  }

  return (
    <div className="pb-0.5">
      <div className="group flex items-center gap-1 rounded-small px-1.5 py-1 hover:bg-bg-hover">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={hoverTitle}
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={cn(
              'shrink-0 text-fg-tertiary transition-transform duration-fast',
              !open && '-rotate-90',
            )}
          />
          <FolderClosed
            size={13}
            aria-hidden
            data-folder-icon="true"
            className="shrink-0"
            style={{ color: accent }}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-dense text-fg-primary">{project.name}</span>
              <span className="shrink-0 text-2xs text-fg-tertiary">{threads.length}</span>
            </span>
            {pathHint ? (
              <span className="truncate text-2xs text-fg-tertiary">{pathHint}</span>
            ) : null}
          </span>
        </button>

        <Tooltip content="在这个文件夹里新建对话">
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewThread}
            aria-label="在这个文件夹里新建对话"
          >
            <Plus size={12} />
          </Button>
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
              <IconButton label="文件夹菜单" size={28}>
                <MoreHorizontal size={14} />
              </IconButton>
            </span>
          )}
        >
          <MenuItem icon={<FileText size={13} />} onSelect={editRules}>
            编辑项目规则
          </MenuItem>
          <MenuItem icon={<Trash2 size={13} />} onSelect={confirmDelete}>
            删除文件夹
          </MenuItem>
        </Popover>
      </div>

      {open ? (
        threads.length === 0 ? (
          <p className="px-4 py-1.5 text-2xs text-fg-tertiary">这个文件夹还没有对话</p>
        ) : (
          threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              onDelete={() => onDeleteThread(thread)}
              onMoveToFolder={() => onMoveThread(thread)}
              onDetachFolder={() => onDetachThread(thread)}
            />
          ))
        )
      ) : null}
    </div>
  )
}
