import { Suspense, useCallback, useEffect, useState } from 'react'
import { BootSequence } from '@/components/boot/BootSequence'
import { useBootGate } from '@/components/boot/useBootGate'
import { Sidebar } from '@/components/layout/Sidebar'
import { BottomPanel, MessageList, RightPanelHost } from '@/components/layout/lazyAppParts'
import { AppTitleBar } from '@/components/layout/AppTitleBar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GlobalLayers } from '@/components/layout/GlobalLayers'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { TaskBanner } from '@/components/chat/TaskBanner'
import { Composer } from '@/components/chat/Composer'
import { useAppBootstrap } from '@/hooks/useAppBootstrap'
import { useOnboardingGate } from '@/hooks/useOnboardingGate'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { LAYOUT } from '@/constants'
import { matchCombo } from '@/lib/utils'
import { useBackendSubscriptions } from '@/hooks/useBackendSubscriptions'
import { useApplyAppearance } from '@/hooks/useApplyAppearance'

/* ══════════════════════════════════════════════════════════════
   App：设置同步到 <html> · 全局快捷键 · 三栏布局
   ══════════════════════════════════════════════════════════════ */

export default function App() {
  const bootstrapReady = useAppBootstrap()
  const { mainMounted, booting, skipping, prepareMain, finishBoot, skipBoot } =
    useBootGate(bootstrapReady)

  return (
    <>
      {mainMounted ? <MainApp /> : null}
      {booting ? (
        <BootSequence
          skipping={skipping}
          onSkip={skipBoot}
          onPrepare={prepareMain}
          onDone={finishBoot}
        />
      ) : null}
    </>
  )
}

function MainApp() {
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
      if (matchCombo(event, shortcut('toggle-bottom', 'mod+j'))) {
        event.preventDefault()
        setBottomOpen((v) => !v)
        return
      }
      if (matchCombo(event, shortcut('toggle-right', 'mod+shift+j'))) {
        event.preventDefault()
        toggleRightPanel()
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
      toggleRightPanel,
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
      {/* 窗口级顶栏（横跨三栏）。也包一层：它一出错整个窗口就没法操作了 */}
      <ErrorBoundary>
        <AppTitleBar onToggleBottomPanel={() => setBottomOpen((v) => !v)} />
      </ErrorBoundary>

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
          <ErrorBoundary>
            <TaskBanner />

            <Suspense fallback={<div className="min-h-0 flex-1" />}>
              <MessageList
                messages={messages}
                onSuggestion={(text) => {
                  setInput(text)
                  sendMessage(text)
                }}
              />
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

        {/* 右侧面板（抽成组件是因为「折叠也不卸载」，里面那段注释值得单独放） */}
        <ErrorBoundary className="shrink-0">
          <Suspense
            fallback={
              rightPanelVisible ? (
                <div className="shrink-0" style={{ width: settings.rightPanelWidth }} />
              ) : null
            }
          >
            <RightPanelHost
              visible={rightPanelVisible}
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
