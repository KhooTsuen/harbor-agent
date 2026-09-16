import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar, StatusBar } from '@/components/layout/TopBar'
import { RightPanelHost } from '@/components/layout/RightPanelHost'
import { BottomPanel } from '@/components/layout/BottomPanel'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Onboarding } from '@/components/onboarding/Onboarding'
import { PREVIEW_CONFIG } from '@/components/onboarding/previewConfig'
import { PermissionDialog } from '@/components/dialogs/PermissionDialog'
import { ToastViewport } from '@/components/ui/Toast'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { MessageList } from '@/components/chat/MessageList'
import { TaskBanner } from '@/components/chat/TaskBanner'
import { Composer } from '@/components/chat/Composer'
import { useOnboardingGate } from '@/hooks/useOnboardingGate'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { LAYOUT } from '@/constants'
import { matchCombo } from '@/lib/utils'
import { getWorkdir, loadConfig, useRealBackend } from '@/lib/backend'
import { useBackendSubscriptions } from '@/hooks/useBackendSubscriptions'
import { configToSettings } from '@/lib/configMapping'
import { useApplyAppearance } from '@/hooks/useApplyAppearance'

/* ══════════════════════════════════════════════════════════════
   App：设置同步到 <html> · 全局快捷键 · 三栏布局
   ══════════════════════════════════════════════════════════════ */

export default function App() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const thread = useAppStore((s) => s.threads.find((t) => t.id === activeThreadId))
  const createThread = useAppStore((s) => s.createThread)
  const deleteThread = useAppStore((s) => s.deleteThread)

  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const setRightPanelVisible = useUIStore((s) => s.setRightPanelVisible)
  const openSettings = useUIStore((s) => s.openSettings)
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen)
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const permissionOpen = useUIStore((s) => s.permission !== null)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const activeRightTab = useUIStore((s) => s.activeRightTab)

  const sendMessage = useThreadStore((s) => s.sendMessage)
  const setInput = useThreadStore((s) => s.setInput)

  /* 底部面板初值取上次的状态，所以打开时不会「闪一下再展开」 */
  const [bottomOpen, setBottomOpen] = useState(settings.lastBottomPanelOpen)
  const setWorkdir = useAppStore((s) => s.setWorkdir)
  const loadFromDisk = useAppStore((s) => s.loadFromDisk)

  /* ① 启动时从主进程拉配置 —— Electron 下以它为准 */
  useEffect(() => {
    if (!useRealBackend) return
    void (async () => {
      /* 先填 useConfigStore，确保设置页拿到真实磁盘配置 */
      await useConfigStore.getState().reload()
      const cfg = await loadConfig()
      if (cfg) {
        const current = useSettingsStore.getState().settings
        useSettingsStore.getState().syncFromConfig(configToSettings(cfg, current))
      }
      const dir = await getWorkdir()
      if (dir) setWorkdir(dir)
      /* 会话列表从真实磁盘读取 */
      await loadFromDisk()

      /* 回到上次打开的那个对话（它可能已被删，那就留在第一个上） */
      const saved = useSettingsStore.getState().settings.lastThreadId
      if (saved && useAppStore.getState().threads.some((t) => t.id === saved)) {
        useAppStore.setState({ activeThreadId: saved })
      }
    })()
  }, [setWorkdir, loadFromDisk])

  /* 后台推来的事件（插件热插拔 / 生图完成）—— 见那个 hook */
  useBackendSubscriptions()

  /* ①b 首次启动引导：没配过 Key 就弹。?onboarding=1 是调试开关 */
  const config = useConfigStore((s) => s.config)
  const showOnboarding = useOnboardingGate()

  /* ② 设置 → <html> 属性（主题 / 玻璃 / 动效 / 字号 / 字体）*/
  useApplyAppearance()

  /* ②b 记住「上次的状态」，下次启动接着用 */
  useEffect(() => {
    updateSettings({ lastThreadId: activeThreadId })
  }, [activeThreadId, updateSettings])

  useEffect(() => {
    updateSettings({ lastRightTab: activeRightTab })
  }, [activeRightTab, updateSettings])

  useEffect(() => {
    updateSettings({ lastBottomPanelOpen: bottomOpen })
  }, [bottomOpen, updateSettings])

  /* ③ 全局快捷键 */
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      /* 弹窗打开时只处理 Esc，其余交给弹窗自己 */
      if (event.key === 'Escape') {
        if (permissionOpen) return /* 权限弹窗自己会关 */
        if (commandPaletteOpen) {
          setCommandPaletteOpen(false)
          return
        }
        if (settingsOpen) return
        return
      }

      const inInput =
        event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)

      /* 命令面板 / 设置 */
      const shortcut = (id: string, fallback: string) => settings.shortcutKeys[id] ?? fallback

      if (matchCombo(event, shortcut('search', 'mod+k'))) {
        event.preventDefault()
        setCommandPaletteOpen(true)
        return
      }
      if (matchCombo(event, shortcut('settings', 'mod+,'))) {
        event.preventDefault()
        openSettings()
        return
      }
      if (matchCombo(event, shortcut('toggle-sidebar', 'mod+b'))) {
        event.preventDefault()
        updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })
        return
      }
      if (matchCombo(event, shortcut('toggle-right', 'mod+j'))) {
        event.preventDefault()
        setBottomOpen((v) => !v)
        return
      }
      if (matchCombo(event, shortcut('diff-tab', 'mod+shift+g'))) {
        event.preventDefault()
        setActiveRightTab('diff')
        setRightPanelVisible(true)
        return
      }
      if (matchCombo(event, shortcut('new-thread', 'mod+n'))) {
        event.preventDefault()
        createThread()
        return
      }
      if (matchCombo(event, shortcut('close-thread', 'mod+w')) && !inInput) {
        event.preventDefault()
        if (activeThreadId) deleteThread(activeThreadId)
        return
      }

      /* Cmd/Ctrl+Enter 发送（sendOnEnter 关掉时是唯一的发送方式） */
      if (matchCombo(event, shortcut('send', 'mod+enter'))) {
        event.preventDefault()
        sendMessage()
      }
    },
    [
      activeThreadId,
      commandPaletteOpen,
      createThread,
      deleteThread,
      openSettings,
      permissionOpen,
      sendMessage,
      setActiveRightTab,
      setCommandPaletteOpen,
      setRightPanelVisible,
      settings.sidebarCollapsed,
      settingsOpen,
      updateSettings,
      settings.shortcutKeys,
    ],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  /* ④ 布局 */
  const messages = thread?.messages ?? []

  return (
    <div className="flex h-full flex-col bg-bg-base text-fg-primary">
      <div className="flex min-h-0 flex-1">
        {/* 侧栏 */}
        <div
          className="shrink-0"
          style={{
            width: settings.sidebarCollapsed ? LAYOUT.sidebar.collapsed : settings.sidebarWidth,
          }}
        >
          {/* 三个区域各自包一层 ErrorBoundary：一处崩了不影响另外两处 */}
          <ErrorBoundary>
            <Sidebar />
          </ErrorBoundary>
        </div>

        {!settings.sidebarCollapsed ? (
          <ResizeHandle
            side="right"
            label="调整侧边栏宽度"
            value={settings.sidebarWidth}
            min={LAYOUT.sidebar.min}
            max={LAYOUT.sidebar.max}
            onChange={(next) => updateSettings({ sidebarWidth: next })}
          />
        ) : null}

        {/* 主区 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="对话区">
          <TopBar onToggleBottomPanel={() => setBottomOpen((v) => !v)} />

          <ErrorBoundary>
            <TaskBanner />

            <MessageList
              messages={messages}
              onSuggestion={(text) => {
                setInput(text)
                sendMessage(text)
              }}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <Composer />
          </ErrorBoundary>

          {bottomOpen ? <BottomPanel onClose={() => setBottomOpen(false)} /> : null}
        </main>

        {/* 右侧面板（抽成组件是因为「折叠也不卸载」，里面那段注释值得单独放） */}
        <RightPanelHost
          visible={rightPanelVisible}
          width={settings.rightPanelWidth}
          min={LAYOUT.rightPanel.min}
          max={LAYOUT.rightPanel.max}
          onToggle={toggleRightPanel}
          onResize={(next) => updateSettings({ rightPanelWidth: next })}
        />
      </div>

      <StatusBar />

      {/* 全局层 */}
      {showOnboarding ? <Onboarding config={config ?? PREVIEW_CONFIG} /> : null}
      <CommandPalette />
      <SettingsModal />
      <PermissionDialog />
      <ToastViewport />
    </div>
  )
}
