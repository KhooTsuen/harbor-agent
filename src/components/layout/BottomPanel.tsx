import { ChevronDown, ScrollText, TerminalSquare, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Terminal } from './Terminal'
import { ToolLogPanel } from './bottom/ToolLogPanel'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   底部面板（Ctrl+J）

   两个视图：运行日志 / 终端。

   「日志」补的是「工具调用记录出了那条对话就找不到」的缺口 ——
   它是全局流水（时间 / 工具 / 状态 / 耗时），可搜索。
   以前这里是「任务」（当前项目的对话列表），但那和侧栏完全重复，已经换掉了。
   ══════════════════════════════════════════════════════════════ */

export interface BottomPanelProps {
  onClose: () => void
}

export function BottomPanel({ onClose }: BottomPanelProps) {
  /* AG-042：视图也放 store —— 「查看 Tool」直接开到日志那一栏 */
  const view = useUIStore((s) => s.bottomPanelView)
  const openBottomPanel = useUIStore((s) => s.openBottomPanel)
  const setView = (next: 'log' | 'terminal') => openBottomPanel(next)

  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))

  return (
    <section
      className="flex shrink-0 flex-col border-t border-line-subtle bg-bg-base"
      style={{ height: 190 }}
      aria-label="底部面板"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1">
        <button
          type="button"
          onClick={() => setView('log')}
          aria-current={view === 'log'}
          className={
            view === 'log'
              ? 'flex items-center gap-1.5 rounded-sm bg-bg-raised px-2 py-1 text-xs text-fg-primary'
              : 'flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary hover:bg-bg-hover'
          }
        >
          <ScrollText size={13} />
          日志
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

      {view === 'log' ? (
        <ToolLogPanel />
      ) : project ? (
        <Terminal project={project} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-2xs text-fg-tertiary">
          请先选择一个项目
        </div>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-line-subtle px-2 py-0.5 text-2xs text-fg-tertiary">
        <ChevronDown size={11} />
        <span>关闭面板</span>
      </footer>
    </section>
  )
}
