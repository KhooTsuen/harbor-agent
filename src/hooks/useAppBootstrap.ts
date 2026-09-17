import { useEffect, useState } from 'react'
import { preloadWorkspaceUi } from '@/components/layout/lazyAppParts'
import { getWorkdir, useRealBackend } from '@/lib/backend'
import { configToSettings } from '@/lib/configMapping'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

let bootstrapPromise: Promise<void> | null = null

async function bootstrap(): Promise<void> {
  if (!useRealBackend) return

  const reloadConfig = useConfigStore.getState().reload()
  const [, workdir] = await Promise.all([reloadConfig, getWorkdir()])

  const config = useConfigStore.getState().config
  if (config) {
    /*
     * 配置损坏时主进程会留一份现场并带上 _loadWarning —— 这里必须告诉用户，
     * 否则他只会发现「设置莫名其妙全没了」。提示里带上备份路径，能自己找回。
     */
    if (config._loadWarning) {
      console.warn('[bootstrap] 配置损坏：', config._loadWarning)
      useUIStore
        .getState()
        .showToast(
          'error',
          '配置文件损坏，已重置',
          '原文件已另存为 config.json.broken-*（在 data 目录下）',
        )
    }
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
