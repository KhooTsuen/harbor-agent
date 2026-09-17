import { useEffect, useState } from 'react'
import { preloadWorkspaceUi } from '@/components/layout/lazyAppParts'
import { getWorkdir, useRealBackend } from '@/lib/backend'
import { configToSettings } from '@/lib/configMapping'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

let bootstrapPromise: Promise<void> | null = null

async function bootstrap(): Promise<void> {
  if (!useRealBackend) return

  const reloadConfig = useConfigStore.getState().reload()
  const [, workdir] = await Promise.all([reloadConfig, getWorkdir()])

  const config = useConfigStore.getState().config
  if (config) {
    const current = useSettingsStore.getState().settings
    useSettingsStore.getState().syncFromConfig(configToSettings(config, current))
  }

  if (workdir) useAppStore.setState({ workdir })
  await useAppStore.getState().loadFromDisk()

  const saved = useSettingsStore.getState().settings.lastThreadId
  if (saved && useAppStore.getState().threads.some((thread) => thread.id === saved)) {
    useAppStore.setState({ activeThreadId: saved })
  }

  await preloadWorkspaceUi()
}

export function useAppBootstrap(): boolean {
  const [ready, setReady] = useState(!useRealBackend)

  useEffect(() => {
    let active = true
    bootstrapPromise ??= bootstrap()
    void bootstrapPromise.then(
      () => {
        if (active) setReady(true)
      },
      () => {
        /* 启动失败也不能永久困在黑幕；主界面自己的错误边界继续接手。 */
        if (active) setReady(true)
      },
    )
    return () => {
      active = false
    }
  }, [])

  return ready
}
