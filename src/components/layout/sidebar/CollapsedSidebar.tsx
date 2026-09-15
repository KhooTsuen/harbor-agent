import { MessageSquarePlus, PanelLeftOpen, Search, Settings } from 'lucide-react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'

/* ══════════════════════════════════════════════════════════════
   折叠态的侧栏（48px 图标条）

   从 Sidebar.tsx 拆出来的 —— 那边加完「上下两栏」之后过 300 行了。
   折叠态和展开态没有任何共享状态，拆开是干净的。
   ══════════════════════════════════════════════════════════════ */

export function CollapsedSidebar({ onCreateThread }: { onCreateThread: () => void }) {
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const openSettings = useUIStore((s) => s.openSettings)

  return (
    <aside
      className="glass-subtle flex h-full flex-col items-center gap-1 border-r border-line-hairline bg-canvas py-2"
      style={{ width: 48 }}
      aria-label="侧边栏（已折叠）"
    >
      <Tooltip content="展开侧边栏（Ctrl+B）" side="right">
        <IconButton label="展开侧边栏" onClick={() => updateSettings({ sidebarCollapsed: false })}>
          <PanelLeftOpen size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip content="新建对话（Ctrl+N）" side="right">
        <IconButton label="新建对话" onClick={onCreateThread}>
          <MessageSquarePlus size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip content="搜索" side="right">
        <IconButton label="搜索对话" onClick={() => updateSettings({ sidebarCollapsed: false })}>
          <Search size={16} />
        </IconButton>
      </Tooltip>
      <div className="mt-auto">
        <Tooltip content="设置（Ctrl+,）" side="right">
          <IconButton label="设置" onClick={openSettings}>
            <Settings size={16} />
          </IconButton>
        </Tooltip>
      </div>
    </aside>
  )
}
