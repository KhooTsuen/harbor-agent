import { Loader2, PanelBottom, PanelLeft, PanelRight, Play, Square } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { sumDiff } from '@/components/chat/DiffViewer'
import { useAgentActive } from '@/hooks/useAgentActive'
import { activityLabel } from '@/lib/agentActivity'

/* ══════════════════════════════════════════════════════════════
   窗口级顶栏（高 40px，**横跨整个窗口**）

   它不属于任何一栏，而是压在左中右三栏之上的一条 —— 这是它和普通顶栏
   唯一的、也是全部的区别。之所以要这样：窗口用了 titleBarStyle:'hidden'，
   系统标题栏的背景被隐藏、界面自己顶到窗口最上沿，原生按钮（最小化 /
   最大化 / 关闭）浮在右上角。这种时候如果顶栏还是「每栏各一条」，顶部
   看起来就是「三块面板顶栏 + 一层系统边框」，而不是一个整体。

   三件事必须同时成立，缺一个就坏：

     ① 整条能拖动窗口（titlebar-drag），但里面的控件要 no-drag —— 见 index.css，
        那边用后代选择器统一排除，免得以后每加一个控件都要记得补
     ② 右侧必须给原生按钮让位（--titlebar-right），否则会被盖上
     ③ **不做卡片、不加圆角**，背景直接用 --bg-canvas、只留底部一条发丝线。
        它是一条「边」，不是一块「板」

   注意它取代了原来的 TopBar（那条只横跨中间列）。右栏那排
   「审查 / 终端 / 文件…」是**第二级**标签栏，留在右栏内部，不往上提 ——
   让窗口按钮和标签栏挤在同一行反而更乱。
   ══════════════════════════════════════════════════════════════ */

export function AppTitleBar({ onToggleBottomPanel }: { onToggleBottomPanel: () => void }) {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const sidebarCollapsed = useSettingsStore((s) => s.settings.sidebarCollapsed)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)

  /* 当前这条对话在不在跑（别的对话跑着是别的事） */
  const sending = useAgentActive(thread?.id)
  const sendMessage = useThreadStore((s) => s.sendMessage)
  const stopGeneration = useThreadStore((s) => s.stopGeneration)

  /*
    AG-008：顶栏顺带说一句「现在到底在干什么」。
    toolRuns 挂在 assistant 消息上，所以要找**最后一条助手消息**，
    不能直接拿 messages.at(-1) —— 那可能是用户刚发出去的那条。
  */
  const lastAssistant = [...(thread?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
  const activity = activityLabel(lastAssistant?.toolRuns ?? [], thread?.phase)

  const diffs = (thread?.messages ?? []).flatMap((m) => m.diffs ?? [])
  const { additions, deletions } = sumDiff(diffs)

  return (
    <header
      className="titlebar-drag glass-panel flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-3"
      style={{ height: 40, paddingRight: 'calc(var(--titlebar-right) + 16px)' }}
    >
      <Tooltip content={sidebarCollapsed ? '展开侧边栏（Ctrl+B）' : '折叠侧边栏（Ctrl+B）'}>
        <IconButton
          label="切换侧边栏"
          size={28}
          onClick={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
        >
          <PanelLeft size={15} />
        </IconButton>
      </Tooltip>

      <span
        aria-hidden="true"
        className="grid size-5 shrink-0 place-items-center rounded-small bg-bg-raised font-mono text-2xs font-semibold text-fg-primary"
      >
        ⌘
      </span>
      <span className="hidden shrink-0 text-dense font-semibold text-fg-primary sm:inline">
        Workbench
      </span>

      {/* 当前对话标题。它是状态不是标题，所以用次级色、不上大字号 */}
      <h1 className="min-w-0 flex-1 truncate px-2 text-dense text-fg-secondary">
        {thread?.title ?? '没有打开的对话'}
      </h1>

      {/*
        只在跑的时候出现，空着不动 —— 顶栏不该有恒定的装饰。
        以前这里是 `hidden md:flex`（窄窗口就看不到活动），改成**总是显示**：
        宽度不够时有 `min-w-0` + `truncate` + `max-w-[38vw]` 兜底，压到 0 也不会挤坏布局。
      */}
      {sending ? (
        <span className="flex min-w-0 max-w-[38vw] shrink items-center gap-1.5 truncate text-2xs text-fg-tertiary">
          <Loader2 size={11} className="shrink-0 animate-spin" />
          <span className="truncate">{activity}</span>
        </span>
      ) : null}

      {diffs.length > 0 ? (
        <span
          className="hidden shrink-0 items-center gap-2 font-mono text-2xs sm:flex"
          title={`${additions} 行新增，${deletions} 行删除`}
        >
          <span style={{ color: 'var(--diff-add)' }}>+{additions}</span>
          <span style={{ color: 'var(--diff-remove)' }}>−{deletions}</span>
        </span>
      ) : null}

      {/*
        右边这四个**故意不挂 Tooltip**，也要把 IconButton 自带的 title 置空。

        它们紧贴原生窗口按钮，提示往下弹会正好落在右栏那排标签
       （审查 / 终端 / 文件…）上，两块字叠在一起，比没提示难看得多。
        图标本身够清楚，无障碍靠 aria-label（IconButton 的 label），不受影响。
      */}
      <div className="flex shrink-0 items-center gap-0.5">
        {sending ? (
          <IconButton label="停止生成" title="" size={28} onClick={stopGeneration}>
            <Square size={13} fill="currentColor" />
          </IconButton>
        ) : (
          <IconButton label="继续" title="" size={28} onClick={() => sendMessage('继续')}>
            <Play size={13} />
          </IconButton>
        )}

        <IconButton label="切换底部面板" title="" size={28} onClick={onToggleBottomPanel}>
          <PanelBottom size={15} />
        </IconButton>

        <IconButton
          label="切换右侧面板"
          title=""
          size={28}
          active={rightPanelVisible}
          onClick={toggleRightPanel}
        >
          <PanelRight size={15} />
        </IconButton>
      </div>
    </header>
  )
}
