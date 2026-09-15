import { ChevronDown, ListChecks, TerminalSquare, X } from 'lucide-react'
import { StatusDot } from '@/components/ui/StatusDot'
import { IconButton } from '@/components/ui/IconButton'
import { Terminal } from './Terminal'
import { useAppStore } from '@/stores/useAppStore'
import { relativeTime } from '@/lib/utils'
import { useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   底部面板（Ctrl+J）

   两个视图：当前项目的所有线程状态 / 终端。
   线程列表在这里是「并行任务监工」的入口——一眼看到哪条在跑、哪条挂了。
   ══════════════════════════════════════════════════════════════ */

export interface BottomPanelProps {
  onClose: () => void
}

export function BottomPanel({ onClose }: BottomPanelProps) {
  const [view, setView] = useState<'threads' | 'terminal'>('threads')

  const threads = useAppStore((s) => s.threads)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))

  const list = threads.filter((t) => t.projectId === activeProjectId)

  return (
    <section
      className="flex shrink-0 flex-col border-t border-line-subtle bg-bg-base"
      style={{ height: 190 }}
      aria-label="底部面板"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1">
        <button
          type="button"
          onClick={() => setView('threads')}
          aria-current={view === 'threads'}
          className={
            view === 'threads'
              ? 'flex items-center gap-1.5 rounded-sm bg-bg-raised px-2 py-1 text-xs text-fg-primary'
              : 'flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary hover:bg-bg-hover'
          }
        >
          <ListChecks size={13} />
          任务
          <span className="font-mono text-2xs text-fg-tertiary">{list.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setView('terminal')}
          aria-current={view === 'terminal'}
          className={
            view === 'terminal'
              ? 'flex items-center gap-1.5 rounded-sm bg-bg-raised px-2 py-1 text-xs text-fg-primary'
              : 'flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary hover:bg-bg-hover'
          }
        >
          <TerminalSquare size={13} />
          终端
        </button>
        <div className="ml-auto">
          <IconButton label="关闭底部面板" size={28} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>

      {view === 'threads' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 ? (
            <p className="px-2 py-4 text-center text-2xs text-fg-tertiary">这个项目下还没有对话</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {list.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => setActiveThread(thread.id)}
                    aria-current={thread.id === activeThreadId}
                    className={
                      thread.id === activeThreadId
                        ? 'flex w-full items-center gap-2 rounded-sm bg-bg-raised px-2 py-1.5 text-left text-xs text-fg-primary'
                        : 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-bg-hover'
                    }
                  >
                    <StatusDot status={thread.status} size={7} />
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                    <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                      {thread.messages.length} 条
                    </span>
                    <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                      {relativeTime(thread.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : project ? (
        <Terminal project={project} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-2xs text-fg-tertiary">
          请先选择一个项目
        </div>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-line-subtle px-2 py-0.5 text-2xs text-fg-tertiary">
        <ChevronDown size={11} />
        <span>Ctrl+J 收起</span>
      </footer>
    </section>
  )
}
