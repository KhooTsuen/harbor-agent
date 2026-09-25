import { useEffect, useMemo, useState } from 'react'
import { Archive, Settings } from 'lucide-react'
import type { Thread } from '@/types'
import { confirmDeleteThread } from '@/lib/confirmDeleteThread'
import { sortThreads, useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { searchSessions, useRealBackend } from '@/lib/backend'
import { IconButton } from '@/components/ui/IconButton'
import { SidebarSkeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { ThreadRow } from './sidebar/ThreadRow'
import { BulkSelectList } from './sidebar/BulkSelectList'
import { SidebarPanes } from './sidebar/SidebarPanes'
import { SidebarHeader } from './sidebar/SidebarHeader'
import { CollapsedSidebar } from './sidebar/CollapsedSidebar'
import { SidebarBranchTree } from './sidebar/SidebarBranchTree'
import { useBulkSelect } from '@/hooks/useBulkSelect'

/* ══════════════════════════════════════════════════════════════
   Sidebar

   结构：功能组 → 项目 → 线程 → 底部（设置 / 用户）。折叠后只剩 48px 图标条。
   刻意不带圆角和投影 —— 侧栏是固定宽度的实心面板，做成「浮起来的外壳」
   就就不像那个感觉了（玻璃拟态打开时会半透明，那是 .glass-subtle 管的，另一回事）。
   ══════════════════════════════════════════════════════════════ */

export interface SidebarProps {
  loading?: boolean
}

export function Sidebar({ loading = false }: SidebarProps) {
  const projects = useAppStore((s) => s.projects)
  const createThread = useAppStore((s) => s.createThread)
  const threads = useAppStore((s) => s.threads)

  const collapsed = useSettingsStore((s) => s.settings.sidebarCollapsed)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const openSettings = useUIStore((s) => s.openSettings)

  const [showArchived, setShowArchived] = useState(false)
  const [remoteHits, setRemoteHits] = useState<
    Array<{ threadId: string; title: string; snippet: string; timestamp: number }>
  >([])
  const bulk = useBulkSelect()

  useEffect(() => {
    if (!useRealBackend || !searchQuery.trim()) {
      setRemoteHits([])
      return
    }
    let alive = true
    void searchSessions(searchQuery, 20).then((hits) => {
      if (alive) setRemoteHits(hits)
    })
    return () => {
      alive = false
    }
  }, [searchQuery])

  /* 项目 → 线程分组，顺带做搜索过滤；归档线程单独一个视图 */
  const archivedThreads = useMemo(
    () =>
      sortThreads(threads.filter((t) => t.archived)).filter((t) =>
        searchQuery ? t.title.toLowerCase().includes(searchQuery.toLowerCase()) : true,
      ),
    [threads, searchQuery],
  )

  /* 没挂在任何文件夹上的对话 —— 侧栏下半栏 */
  const looseThreads = useMemo(
    () =>
      sortThreads(threads.filter((t) => !t.projectId && !t.archived)).filter((t) =>
        searchQuery ? t.title.toLowerCase().includes(searchQuery.toLowerCase()) : true,
      ),
    [threads, searchQuery],
  )

  const grouped = useMemo(
    () =>
      projects.map((project) => ({
        project,
        threads: sortThreads(
          threads.filter((t) => t.projectId === project.id && !t.archived),
        ).filter((t) =>
          searchQuery ? t.title.toLowerCase().includes(searchQuery.toLowerCase()) : true,
        ),
      })),
    [projects, threads, searchQuery],
  )

  function requestDeleteThread(thread: Thread): void {
    /* 确认文案与 Ctrl+W 那条路共用一处（见 lib/confirmDeleteThread.ts） */
    confirmDeleteThread(thread.id)
  }

  if (collapsed) return <CollapsedSidebar onCreateThread={() => createThread()} />

  return (
    <aside
      className="glass-subtle flex h-full min-h-0 flex-col border-r border-line-hairline bg-canvas"
      aria-label="侧边栏"
    >
      <SidebarHeader />

      {/*
        主体分几种形态：批量选择 / 骨架屏 / 已归档 / 正常的两栏。
        两栏那一种自带分隔线，所以这里不用再包一层滚动容器。
      */}
      {bulk.active ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <BulkSelectList threads={threads} selected={bulk.selected} onToggle={bulk.toggle} />
        </div>
      ) : loading ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <SidebarSkeleton />
        </div>
      ) : showArchived ? (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="已归档的对话">
          {archivedThreads.length === 0 ? (
            <p className="px-2 py-4 text-center text-2xs text-fg-tertiary">没有归档的对话</p>
          ) : (
            archivedThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onDelete={() => requestDeleteThread(thread)}
              />
            ))
          )}
        </nav>
      ) : (
        <>
          {remoteHits.length > 0 ? (
            <div className="border-b border-line-hairline px-2 pb-2">
              <p className="px-2 py-1 text-2xs text-fg-tertiary">消息命中</p>
              {remoteHits.map((hit) => (
                <button
                  key={`${hit.threadId}-${hit.timestamp}`}
                  type="button"
                  className="w-full rounded-sm px-2 py-1 text-left hover:bg-bg-hover"
                  onClick={() => useAppStore.getState().setActiveThread(hit.threadId)}
                >
                  <span className="block truncate text-xs text-fg-primary">{hit.title}</span>
                  <span className="block truncate text-2xs text-fg-tertiary">{hit.snippet}</span>
                </button>
              ))}
            </div>
          ) : null}
          <SidebarPanes
            folderList={grouped.map(({ project, threads: list }) => ({ project, threads: list }))}
            looseThreads={looseThreads}
            onDeleteThread={requestDeleteThread}
          />
        </>
      )}

      {/* 当前对话的分支树（可折叠）—— 放底部，不挤线程列表 */}
      <SidebarBranchTree />

      {/* 底部 */}
      <footer className="flex items-center gap-1 border-t border-line-hairline px-2 py-2">
        <Tooltip content={showArchived ? '回到对话列表' : '已归档'}>
          <IconButton
            label={showArchived ? '回到对话列表' : '查看已归档'}
            active={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            <Archive size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip content="设置（Ctrl+,）">
          <IconButton label="设置" onClick={() => openSettings()}>
            <Settings size={15} />
          </IconButton>
        </Tooltip>
      </footer>
    </aside>
  )
}
