import { useMemo } from 'react'
import { PanelBottom, PanelLeft, PanelRight, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount, formatTokens } from '@/lib/format'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { sumDiff } from '@/components/chat/DiffViewer'

/* ══════════════════════════════════════════════════════════════
   TopBar（高 48px）

   顶栏照参考实现：左＝侧栏开关，中＝标题，右＝动作组 + 变更统计。
   变更统计（+n −n）是「状态自曝」的典型——不用点开就知道改了多少。
   ══════════════════════════════════════════════════════════════ */

export function TopBar({ onToggleBottomPanel }: { onToggleBottomPanel: () => void }) {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const toggleSidebar = useSettingsStore((s) => s.updateSettings)
  const sidebarCollapsed = useSettingsStore((s) => s.settings.sidebarCollapsed)

  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)

  /* 当前这条对话在不在跑（别的对话跑着是别的事） */
  const sending = thread?.status === 'running'
  const sendMessage = useThreadStore((s) => s.sendMessage)
  const stopGeneration = useThreadStore((s) => s.stopGeneration)

  const diffs = (thread?.messages ?? []).flatMap((m) => m.diffs ?? [])
  const { additions, deletions } = sumDiff(diffs)
  const hasDiff = diffs.length > 0

  return (
    <header
      className="glass-panel flex shrink-0 items-center gap-2 border-b border-line-subtle px-3"
      style={{ height: 48 }}
    >
      <Tooltip content={sidebarCollapsed ? '展开侧边栏（Ctrl+B）' : '折叠侧边栏（Ctrl+B）'}>
        <IconButton
          label="切换侧边栏"
          onClick={() => toggleSidebar({ sidebarCollapsed: !sidebarCollapsed })}
        >
          <PanelLeft size={16} />
        </IconButton>
      </Tooltip>

      <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-fg-primary">
        {thread?.title ?? '没有打开的对话'}
      </h1>

      {hasDiff ? (
        <span
          className="hidden shrink-0 items-center gap-2 font-mono text-2xs sm:flex"
          title={`${additions} 行新增，${deletions} 行删除`}
        >
          <span style={{ color: 'var(--diff-add)' }}>+{additions}</span>
          <span style={{ color: 'var(--diff-remove)' }}>−{deletions}</span>
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-0.5">
        {sending ? (
          <Tooltip content="停止生成">
            <IconButton label="停止生成" onClick={stopGeneration}>
              <Square size={14} fill="currentColor" />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip content="继续这一轮">
            <IconButton label="继续" onClick={() => sendMessage('继续')}>
              <Play size={14} />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip content="底部面板（Ctrl+J）">
          <IconButton label="切换底部面板" onClick={onToggleBottomPanel}>
            <PanelBottom size={16} />
          </IconButton>
        </Tooltip>

        <Tooltip content="右侧面板（Ctrl+J）">
          <IconButton label="切换右侧面板" active={rightPanelVisible} onClick={toggleRightPanel}>
            <PanelRight size={16} />
          </IconButton>
        </Tooltip>
      </div>
    </header>
  )
}

/* ══════════════════════════════════════════════════════════════
   StatusBar（高 28px）—— 放在窗口最底下
   ══════════════════════════════════════════════════════════════ */

export function StatusBar() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))

  /* 当前会话的 token 用量：把每条回复身上的 usage 加起来 */
  const tokens = useMemo(() => {
    let prompt = 0
    let completion = 0
    for (const message of thread?.messages ?? []) {
      if (!message.usage) continue
      prompt += message.usage.prompt ?? 0
      completion += message.usage.completion ?? 0
    }
    return { prompt, completion, total: prompt + completion }
  }, [thread])
  /*
   * 工作目录只在 Composer 下面显示一次；状态栏不再重复。
   * （同一份信息出现两处，用户会以为是两个不同的目录。）
   */
  /* 状态栏说的是「应用整体忙不忙」—— 任意一条对话在跑都算 */
  const sending = useThreadStore((s) => s.sendingThreads.length > 0)
  const mode = thread?.mode ?? 'pair'

  return (
    <footer
      className="glass-panel flex shrink-0 items-center gap-3 border-t border-line-subtle px-3 text-2xs text-fg-tertiary"
      style={{ height: 28 }}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={cn('inline-block size-1.5 rounded-full', sending && 'animate-pulse')}
          style={{ background: sending ? 'var(--warning)' : 'var(--success)' }}
        />
        {sending ? '生成中' : '就绪'}
      </span>

      <span className="font-mono">{mode}</span>
      <span className="font-mono">{thread?.model ?? '—'}</span>
      <span className="hidden font-mono sm:inline">{thread?.reasoning ?? '—'}</span>

      {/* token 用量：位置紧张，只用 ↑↓ 加缩写，完整数字挂 title */}
      {tokens.total > 0 ? (
        <span
          className="ml-auto hidden shrink-0 font-mono md:inline"
          title={`本会话 token：输入 ${formatCount(tokens.prompt)} · 输出 ${formatCount(tokens.completion)} · 合计 ${formatCount(tokens.total)}`}
        >
          ↑{formatTokens(tokens.prompt)} ↓{formatTokens(tokens.completion)}
        </span>
      ) : null}
    </footer>
  )
}
