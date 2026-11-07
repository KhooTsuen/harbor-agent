import { useCallback, useEffect, useState } from 'react'
import { BootSequence } from '@/components/boot/BootSequence'
import { useBootGate } from '@/components/boot/useBootGate'
import { MainArea } from '@/components/layout/MainArea'
import { useAppBootstrap } from '@/hooks/useAppBootstrap'
import { useOnboardingGate } from '@/hooks/useOnboardingGate'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { confirmDeleteThread } from '@/lib/confirmDeleteThread'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { matchCombo } from '@/lib/utils'
import { useBackendSubscriptions } from '@/hooks/useBackendSubscriptions'
import { useApplyAppearance } from '@/hooks/useApplyAppearance'
import { useExtBridge } from '@/hooks/useExtBridge'

/* ══════════════════════════════════════════════════════════════
   App：设置同步到 <html> · 全局快捷键 · 三栏布局
   ══════════════════════════════════════════════════════════════ */

export default function App() {
  const bootstrapReady = useAppBootstrap()
  const bootAnimation = useSettingsStore((s) => s.settings.bootAnimation)
  const { mainMounted, booting, skipping, prepareMain, finishBoot, skipBoot } = useBootGate(
    bootstrapReady,
    bootAnimation,
  )

  return (
    <>
      {mainMounted ? <MainApp /> : null}
      {booting ? (
        <BootSequence
          ready={bootstrapReady}
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
  const createThread = useAppStore((s) => s.createThread)

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

  /* AG-042：底部面板开合搬进 store（任务行的「查看 Tool」要能打开它），初值取上次的状态 */
  const bottomOpen = useUIStore((s) => s.bottomPanelOpen)
  const setBottomOpen = useUIStore((s) => s.setBottomPanelOpen)
  /* right tab 住在临时 UI store，必须从持久化设置恢复（以前只存不读，启动总回 diff） */
  const [rightTabRestored, setRightTabRestored] = useState(false)

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

  /* ②c Phase 2：扩展桥（上报当前会话 + 收到 ext:page 时刷新界面） */
  useExtBridge(activeThreadId)
  useEffect(() => {
    if (rightTabRestored) return
    setActiveRightTab(settings.lastRightTab)
    setRightTabRestored(true)
    /* 只在挂载时恢复一次；之后由下面的 effect 记录用户切换。 */
  }, [rightTabRestored, setActiveRightTab, settings.lastRightTab])

  useEffect(() => {
    if (rightTabRestored) updateSettings({ lastRightTab: activeRightTab })
  }, [activeRightTab, rightTabRestored, updateSettings])

  /* 底部面板：启动恢复「上次开没开」，之后变化就存回去 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setBottomOpen(Boolean(settings.lastBottomPanelOpen)), [])
  useEffect(() => updateSettings({ lastBottomPanelOpen: bottomOpen }), [bottomOpen, updateSettings])

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
        setBottomOpen(!bottomOpen)
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
        /* 和侧栏那条路一样：确认里会说明「任务记录一起删」 */
        if (activeThreadId) confirmDeleteThread(activeThreadId)
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
      bottomOpen,
      commandPaletteOpen,
      createThread,
      openSettings,
      permissionOpen,
      sendMessage,
      setActiveRightTab,
      setBottomOpen,
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

  /* ④ 布局（三栏 + 设置工作区，见 components/layout/MainArea.tsx） */
  return <MainArea config={config} showOnboarding={showOnboarding} />
}
