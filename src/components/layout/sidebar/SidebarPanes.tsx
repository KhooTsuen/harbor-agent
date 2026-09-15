import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderPlus, MessageSquarePlus, Plus } from 'lucide-react'
import type { Thread } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { chooseFolder } from '@/lib/backend'
import { clamp, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { Tooltip } from '@/components/ui/Tooltip'
import { ThreadRow } from './ThreadRow'

/* ══════════════════════════════════════════════════════════════
   侧栏的两个列表 + 中间那条分隔线

   上半 = 对话文件夹（每个文件夹 = 一个工作目录，可以有很多个）
   下半 = 单独对话（没有挂到任何文件夹上，可以随时挂过去、也可以一直不挂）

   分隔线可上下拖，**带限位**：任何一栏都不能被拖成 0 高度 ——
   挤没之后手柄也跟着消失，那一栏就再也回不来了。

   高度按百分比存（窗口大小变了也不会把某一栏挤没）。
   ══════════════════════════════════════════════════════════════ */

/** 上下两栏各自的最小高度（px）。手柄本身也走这个余量 */
const MIN_TOP = 76
const MIN_BOTTOM = 104

export interface SidebarPanesProps {
  folderList: Array<{
    project: { id: string; name: string; path: string }
    threads: Thread[]
  }>
  looseThreads: Thread[]
  onDeleteThread: (thread: Thread) => void
}

export function SidebarPanes({ folderList, looseThreads, onDeleteThread }: SidebarPanesProps) {
  const createThread = useAppStore((s) => s.createThread)
  const setThreadWorkdir = useAppStore((s) => s.setThreadWorkdir)

  const percent = useSettingsStore((s) => s.settings.sidebarFolderPercent)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const showToast = useUIStore((s) => s.showToast)

  const boxRef = useRef<HTMLDivElement>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  /** 拖拽过程中的临时值（不写设置，松手才写，免得拖一次写几十遍 localStorage） */
  const [dragHeight, setDragHeight] = useState<number | null>(null)

  /* 容器高度：算 max 用。窗口缩放 / 侧栏折叠都要跟着变 */
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = (): void => setBoxHeight(el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const maxTop = Math.max(MIN_TOP, boxHeight - MIN_BOTTOM)
  const topHeight = dragHeight ?? clamp(((percent || 45) / 100) * boxHeight, MIN_TOP, maxTop)

  /** 新建一条对话；dir 给了就直接挂到那个目录（可以是还没出现过的目录） */
  const newThread = useCallback(
    (projectId?: string, dir?: string) => {
      void createThread(projectId, dir)
    },
    [createThread],
  )

  /** 弹目录选择框 → 新建一条挂在该目录下的对话 */
  async function newThreadInFolder(): Promise<void> {
    const picked = await chooseFolder()
    if (!picked.ok || !picked.dir) return
    newThread('', picked.dir)
    showToast('success', '已新建对话', picked.dir)
  }

  /** 把某条对话挂到目录（或摘掉） */
  async function moveThread(thread: Thread): Promise<void> {
    const picked = await chooseFolder()
    if (!picked.ok || !picked.dir) return
    await setThreadWorkdir(thread.id, picked.dir)
    showToast('success', '已挂到文件夹', picked.dir)
  }

  async function detachThread(thread: Thread): Promise<void> {
    await setThreadWorkdir(thread.id, '')
    showToast('info', '已移出文件夹', '它现在是一条单独对话')
  }

  return (
    <div ref={boxRef} className="flex min-h-0 flex-1 flex-col">
      {/* ── 上：对话文件夹 ── */}
      <section
        style={{ height: boxHeight > 0 ? topHeight : undefined }}
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        aria-label="对话文件夹"
      >
        <header className="flex shrink-0 items-center gap-0.5 px-3 py-1">
          <span className="text-2xs uppercase tracking-wide text-fg-tertiary">对话文件夹</span>
          <span className="text-2xs text-fg-tertiary">{folderList.length || ''}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip content="新建对话（放进第一个文件夹）">
              <IconButton
                label="新建对话"
                size={28}
                onClick={() => newThread(folderList[0]?.project.id ?? '')}
              >
                <MessageSquarePlus size={13} />
              </IconButton>
            </Tooltip>
            <Tooltip content="新建对话并指定目录">
              <IconButton
                label="新建对话并指定目录"
                size={28}
                onClick={() => void newThreadInFolder()}
              >
                <FolderPlus size={13} />
              </IconButton>
            </Tooltip>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {folderList.length === 0 ? (
            <p className="px-2 py-3 text-2xs leading-relaxed text-fg-tertiary">
              还没有文件夹。用上面的
              <FolderPlus size={11} className="mx-0.5 inline align-[-1px]" />
              指定一个目录，它就会变成一个文件夹。
            </p>
          ) : (
            folderList.map(({ project, threads }) => (
              <FolderSection
                key={project.id}
                project={project}
                threads={threads}
                onDeleteThread={onDeleteThread}
                onMoveThread={moveThread}
                onDetachThread={detachThread}
                onNewThread={() => newThread(project.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* ── 分隔线（可上下拖，带限位）── */}
      <ResizeHandle
        orientation="vertical"
        side="bottom"
        value={topHeight}
        min={MIN_TOP}
        max={maxTop}
        label="调整文件夹与单独对话的分栏高度"
        onChange={setDragHeight}
        onCommit={(next) => {
          setDragHeight(null)
          if (boxHeight > 0) updateSettings({ sidebarFolderPercent: (next / boxHeight) * 100 })
        }}
      />

      {/* ── 下：单独对话 ── */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="单独对话">
        <header className="flex shrink-0 items-center gap-0.5 px-3 py-1">
          <span className="text-2xs uppercase tracking-wide text-fg-tertiary">单独对话</span>
          <span className="text-2xs text-fg-tertiary">{looseThreads.length || ''}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip content="新建单独对话（不挂目录，用默认工作目录）">
              <IconButton label="新建单独对话" size={28} onClick={() => newThread('')}>
                <Plus size={13} />
              </IconButton>
            </Tooltip>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {looseThreads.length === 0 ? (
            <p className="px-2 py-3 text-2xs leading-relaxed text-fg-tertiary">
              这里放不挂目录的对话。可以随时用行末菜单把它挂到某个文件夹。
            </p>
          ) : (
            looseThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onDelete={() => onDeleteThread(thread)}
                onMoveToFolder={() => void moveThread(thread)}
                onDetachFolder={() => void detachThread(thread)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}

/** 一个文件夹：标题 + 它下面的对话 */
function FolderSection({
  project,
  threads,
  onDeleteThread,
  onMoveThread,
  onDetachThread,
  onNewThread,
}: {
  project: { id: string; name: string; path: string }
  threads: Thread[]
  onDeleteThread: (thread: Thread) => void
  onMoveThread: (thread: Thread) => void
  onDetachThread: (thread: Thread) => void
  onNewThread: () => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="pb-0.5">
      <div className="group flex items-center gap-1 rounded-small px-1.5 py-1 hover:bg-bg-hover">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={project.path}
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={cn(
              'shrink-0 text-fg-tertiary transition-transform duration-fast',
              !open && '-rotate-90',
            )}
          />
          <span className="truncate text-dense text-fg-primary">{project.name}</span>
          <span className="shrink-0 text-2xs text-fg-tertiary">{threads.length}</span>
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
