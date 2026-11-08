import { cn } from '@/lib/utils'
import {
  EXTENSION_TABS,
  useExtensionTabStore,
  type ExtensionTab,
} from '@/stores/useExtensionTabStore'

/* ══════════════════════════════════════════════════════════════
   「工具与扩展」的三个能力区域

   键盘行为与左侧导航、模型页、权限页完全一致（← → / Home / End），
   这样用户在设置区里怎么走，到处都一样。
   ══════════════════════════════════════════════════════════════ */

const LABELS: Record<ExtensionTab, string> = {
  browser: '浏览器扩展',
  skills: '技能',
  mcp: 'MCP 服务器',
}

export function ExtensionTabs(): React.ReactElement {
  const current = useExtensionTabStore((s) => s.tab)
  const setTab = useExtensionTabStore((s) => s.setTab)

  const step = (delta: number): void => {
    const at = EXTENSION_TABS.indexOf(current)
    const next = Math.min(EXTENSION_TABS.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))
    setTab(EXTENSION_TABS[next])
  }

  return (
    <div
      role="tablist"
      aria-label="工具与扩展的分类"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          step(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          setTab(EXTENSION_TABS[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          setTab(EXTENSION_TABS[EXTENSION_TABS.length - 1])
        }
      }}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle pb-2"
    >
      {EXTENSION_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={current === id}
          tabIndex={current === id ? 0 : -1}
          onClick={() => setTab(id)}
          className={cn(
            'shrink-0 rounded-sm px-3 py-1.5 text-dense transition-colors duration-fast',
            current === id
              ? 'bg-bg-raised text-fg-primary'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
          )}
        >
          {LABELS[id]}
        </button>
      ))}
    </div>
  )
}
