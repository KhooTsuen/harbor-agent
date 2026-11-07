import { Suspense } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { BottomPanel, MessageList, RightPanelHost } from '@/components/layout/lazyAppParts'
import { AppTitleBar } from '@/components/layout/AppTitleBar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GlobalLayers } from '@/components/layout/GlobalLayers'
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { Composer } from '@/components/chat/Composer'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAppStore } from '@/stores/useAppStore'
import { LAYOUT } from '@/constants'
import { cn } from '@/lib/utils'
import type { AppConfig } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   主布局（从 App.tsx 抽出来 —— 那边要留给快捷键与引导）

   ── 本阶段最重要的一条规矩 ────────────────────────────────────
   进设置工作区时，**聊天区不卸载，只加 `hidden`**。

   改成条件渲染会发生（都是真机上能看见的）：
     · Composer 里没发出去的草稿没了
     · MessageList 重新挂载 → 滚动位置归零、开屏动画再放一次
     · 正在流式的回复**没人接了**（订阅跟着组件卸载），回来看到半截
     · 正在跑的任务的进度、工具状态全断

   和 `RightPanelHost` 折叠时同一个道理（见那边的文件头）。侧栏同理 ——
   它有滚动位置和当前选中的文件夹。

   ── 设置工作区自己反而不需要保 ────────────────────────────────
   它没有长生命周期的现场（当前页存在 store 里），关掉就卸载，省内存。
   ══════════════════════════════════════════════════════════════ */

export interface MainAreaProps {
  config: AppConfig | null
  showOnboarding: boolean
}

export function MainArea({ config, showOnboarding }: MainAreaProps): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const messages = thread?.messages ?? []

  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const bottomOpen = useUIStore((s) => s.bottomPanelOpen)
  const setBottomOpen = useUIStore((s) => s.setBottomPanelOpen)

  return (
    <div className="flex h-full flex-col bg-bg-base text-fg-primary">
      {/* 窗口级顶栏（横跨三栏）。也包一层：它一出错整个窗口就没法操作了 */}
      <ErrorBoundary>
        <AppTitleBar onToggleBottomPanel={() => setBottomOpen(!bottomOpen)} />
      </ErrorBoundary>

      <div className="flex min-h-0 flex-1">
        {/* 侧栏：进设置时隐藏但不卸载（滚动位置 / 选中文件夹要留着） */}
        <div
          className={cn('shrink-0', settingsOpen && 'hidden')}
          style={{
            width: settings.sidebarCollapsed ? LAYOUT.sidebar.collapsed : settings.sidebarWidth,
          }}
        >
          {/* 三个区域各自包一层 ErrorBoundary：一处崩了不影响另外两处 */}
          <ErrorBoundary>
            <Sidebar />
          </ErrorBoundary>
        </div>

        {!settings.sidebarCollapsed && !settingsOpen ? (
          <ResizeHandle
            side="right"
            label="调整侧边栏宽度"
            value={settings.sidebarWidth}
            min={LAYOUT.sidebar.min}
            max={LAYOUT.sidebar.max}
            onChange={(next) => updateSettings({ sidebarWidth: next })}
          />
        ) : null}

        {/* ★ 始终挂载，只切 hidden —— 理由见文件头 */}
        <main
          className={cn('flex min-h-0 min-w-0 flex-1 flex-col', settingsOpen && 'hidden')}
          aria-label="对话区"
        >
          <ErrorBoundary>
            <Suspense fallback={<div className="min-h-0 flex-1" />}>
              {/* 空对话时 MessageList 自己渲染开屏（launch/LaunchScreen.tsx） */}
              <MessageList messages={messages} conversationId={activeThreadId} />
            </Suspense>
          </ErrorBoundary>

          <ErrorBoundary>
            <Composer />
          </ErrorBoundary>

          {/* 底部面板也要包：它一崩，历史上会把整个应用卸载成白屏 */}
          {bottomOpen ? (
            <ErrorBoundary>
              <Suspense fallback={null}>
                <BottomPanel onClose={() => setBottomOpen(false)} />
              </Suspense>
            </ErrorBoundary>
          ) : null}
        </main>

        {/* 设置工作区：主区域里的完整界面（不是弹窗）。关掉就卸载，它没有要保的现场 */}
        {settingsOpen ? (
          <ErrorBoundary>
            <div className="min-w-0 flex-1">
              <SettingsWorkspace />
            </div>
          </ErrorBoundary>
        ) : null}

        {/* 右侧面板（抽成组件是因为「折叠也不卸载」，里面那段注释值得单独放） */}
        <ErrorBoundary className={cn('shrink-0', settingsOpen && 'hidden')}>
          <Suspense
            fallback={
              rightPanelVisible && !settingsOpen ? (
                <div className="shrink-0" style={{ width: settings.rightPanelWidth }} />
              ) : null
            }
          >
            <RightPanelHost
              visible={rightPanelVisible && !settingsOpen}
              width={settings.rightPanelWidth}
              min={LAYOUT.rightPanel.min}
              max={LAYOUT.rightPanel.max}
              onToggle={toggleRightPanel}
              onResize={(next) => updateSettings({ rightPanelWidth: next })}
            />
          </Suspense>
        </ErrorBoundary>
      </div>

      <ErrorBoundary>
        <StatusBar />
      </ErrorBoundary>

      {/* 全局层：弹窗 / 覆盖层（里面自带 Suspense + ErrorBoundary） */}
      <GlobalLayers config={config} showOnboarding={showOnboarding} />
    </div>
  )
}
