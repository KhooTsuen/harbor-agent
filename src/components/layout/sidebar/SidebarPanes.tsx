import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FolderPlus, Plus } from 'lucide-react'
import type { Thread } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { chooseFolder } from '@/lib/backend'
import { clamp } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { Tooltip } from '@/components/ui/Tooltip'
import { FolderSection } from './FolderSection'
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
/**
 * 「单独对话」**空着**的时候，允许把它压到只剩一条标题栏。
 *
 * 为什么单独给一个更小的值：没有内容的一栏占着 104px 是纯浪费，
 * 用户想把它让给上面的文件夹。但**不能压到 0** —— 压没了手柄跟着消失，
 * 那一栏就再也回不来了（这个坑 ResizeHandle 的文件头写着）。
 * 所以下限取标题栏的高度（40px），手柄始终抓得到。
 */
const MIN_BOTTOM_EMPTY = 40
/** 「恢复高度」按钮回到的分栏比例（和默认值一致） */
const DEFAULT_PERCENT = 45

export interface SidebarPanesProps {
  folderList: Array<{
    project: { id: string; name: string; path: string; color?: string }
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

  /*
   * 「单独对话」空着时下限更小（见 MIN_BOTTOM_EMPTY）：空一栏不该白占 104px。
   * 手柄仍然在，所以随时能拖回来；另外标题栏上给一个「恢复高度」的按钮，
   * 拖到很扁之后**一眼就知道怎么回去**（不靠用户记住拖了多少）。
   */
  const bottomEmpty = looseThreads.length === 0
  const minBottom = bottomEmpty ? MIN_BOTTOM_EMPTY : MIN_BOTTOM
  const maxTop = Math.max(MIN_TOP, boxHeight - minBottom)
  const topHeight =
    dragHeight ?? clamp(((percent || DEFAULT_PERCENT) / 100) * boxHeight, MIN_TOP, maxTop)
  /** 现在是不是「被压小了」—— 决定要不要露那个恢复按钮 */
  const squeezed = boxHeight > 0 && boxHeight - topHeight <= MIN_BOTTOM_EMPTY + 8

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
            {/*
              这里原来还有一个「新建对话（放进第一个文件夹）」的按钮 —— 已去掉：
              它是「单独对话还是主路」那会儿的遗留，指向的是「folderList[0]」这个随手挑的文件夹，
              语义模糊（放哪个文件夹？为什么是第一个？），而且和下面「单独对话」那一栏的「新建单独对话」
              职责重叠。现在这一栏只留一个入口：「新建对话并指定目录」——目录选定，归属自然就定了。
            */}
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
          {/* 空的时候不留说明文字（用户明确说这段删掉）—— 上面那排图标自己会说话 */}
          {folderList.length === 0
            ? null
            : folderList.map(({ project, threads }) => (
                <FolderSection
                  key={project.id}
                  project={project}
                  threads={threads}
                  onDeleteThread={onDeleteThread}
                  onMoveThread={moveThread}
                  onDetachThread={detachThread}
                  onNewThread={() => newThread(project.id)}
                />
              ))}
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
            {/*
              被压小了就给一个一按就回到默认比例的出口。
              没有它的话：拖到只剩标题栏之后，用户只能靠再拖那条 1px 线猜着拉回来。
            */}
            {squeezed ? (
              <Tooltip content="恢复这一栏的高度">
                <IconButton
                  label="恢复单独对话栏高度"
                  size={28}
                  onClick={() => updateSettings({ sidebarFolderPercent: DEFAULT_PERCENT })}
                >
                  <ChevronUp size={13} />
                </IconButton>
              </Tooltip>
            ) : bottomEmpty ? (
              <Tooltip content="把这个空出来的位置让给上面的文件夹">
                <IconButton
                  label="收起空的单独对话栏"
                  size={28}
                  onClick={() => {
                    if (boxHeight <= 0) return
                    updateSettings({
                      sidebarFolderPercent: ((boxHeight - MIN_BOTTOM_EMPTY) / boxHeight) * 100,
                    })
                  }}
                >
                  <ChevronDown size={13} />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip content="新建单独对话（不挂目录，用默认工作目录）">
              <IconButton label="新建单独对话" size={28} onClick={() => newThread('')}>
                <Plus size={13} />
              </IconButton>
            </Tooltip>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {bottomEmpty ? (
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
