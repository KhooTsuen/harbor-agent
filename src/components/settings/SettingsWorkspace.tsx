import { useCallback, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { SettingsNavRail } from './SettingsNavRail'
import { SettingsPage, navItemOf } from './SettingsPage'
import { SettingsSearchBox } from './SettingsSearchBox'
import { settingsPageOf } from './settingsPages'
import { SETTINGS_HOME, isSettingsTabId, type SettingsTabId } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   设置工作区 —— 主区域里的完整设置界面（不是弹窗）

   ── 和弹窗的关系 ──────────────────────────────────────────────
   这是**主入口**。`SettingsModal` 保留为过渡兼容（旧的 openSettings
   仍然能用），但两者渲染的页面来自同一张装配表 `settingsPages.tsx`，
   所以不存在「两边各有一套、改了一边另一边失效」。

   ── 状态归属（三处，各有明确职责）─────────────────────────────
     · `useUIStore.settingsOpen`   —— 主区域现在显示聊天还是设置
     · `useUIStore.settingsTab`    —— 这次打开落在哪一页（临时，可被入口指定）
     · `useSettingsStore.lastSettingsTab` —— 上次访问的页（持久化，重开回到这儿）
   当前页 = `settingsTab ?? lastSettingsTab`，回落 `SETTINGS_HOME`（脏值也走这条）。
   只有一个来源，不在组件里再存一份 —— 否则「记住上次」会时灵时不灵。

   ── 为什么不卸载聊天区 ────────────────────────────────────────
   见 `App.tsx`：聊天区一直挂着，只切 `hidden`。这个组件只负责画自己，
   不碰聊天区的生命周期。
   ══════════════════════════════════════════════════════════════ */

export function SettingsWorkspace(): React.ReactElement {
  const closeSettings = useUIStore((s) => s.closeSettings)
  const requested = useUIStore((s) => s.settingsTab)
  const setRequested = useUIStore((s) => s.setSettingsTab)

  const lastTab = useSettingsStore((s) => s.settings.lastSettingsTab)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const settingsView = useSettingsStore((s) => s.settings.settingsView)

  /* 当前页：入口指定的 > 上次访问的 > 首页。三处脏值一律回落，不留白屏 */
  const current: SettingsTabId = useMemo(() => {
    if (isSettingsTabId(requested)) return requested
    if (isSettingsTabId(lastTab)) return lastTab
    return SETTINGS_HOME
  }, [requested, lastTab])

  const pick = useCallback(
    (id: SettingsTabId) => {
      /* 只改「这次落在哪」，同时把「上次访问」记下来（重开回到这儿） */
      setRequested(id)
      updateSettings({ lastSettingsTab: id })
      /* 换页时清掉搜索词：结果列表压着新页面会让用户以为没跳过去 */
      setQuery('')
    },
    [setRequested, updateSettings],
  )

  const [query, setQuery] = useState('')
  const tabOf = useCallback((id: SettingsTabId) => navItemOf(id), [])
  const tab = navItemOf(current) ?? navItemOf(SETTINGS_HOME)!

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base" aria-label="设置工作区">
      <header className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-4 py-2">
        <button
          type="button"
          onClick={closeSettings}
          aria-label="返回聊天"
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          <ArrowLeft size={13} aria-hidden />
          返回聊天
        </button>

        {/* 搜索：放在顶部一整条，占满剩余宽度 —— 找不到东西时第一反应就是搜 */}
        <div className="min-w-0 flex-1">
          <SettingsSearchBox
            query={query}
            onQueryChange={setQuery}
            tabOf={tabOf}
            view={settingsView}
            onPick={(entry) => pick(entry.tab)}
          />
        </div>

        <span className="shrink-0 text-2xs text-fg-tertiary">
          {tab.group ? `${tab.group} · ${tab.label}` : tab.label}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <SettingsNavRail current={current} onPick={pick} />
        <main className="min-w-0 flex-1" aria-label={tab.label}>
          {/* 一页崩了不该带走整个工作区（更不该带走挂着的聊天区） */}
          <ErrorBoundary>
            <SettingsPage tab={tab}>{settingsPageOf(current)}</SettingsPage>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
