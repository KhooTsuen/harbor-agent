import { useEffect, useState } from 'react'
import { preloadWorkspaceUi } from '@/components/layout/lazyAppParts'
import { getWorkdir, useRealBackend } from '@/lib/backend'
import { configToSettings } from '@/lib/configMapping'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTaskStore } from '@/stores/useTaskStore'

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

  /*
   * AG-012：如果上次有没做完的任务，**让用户知道**。
   *
   * 任务横幅只看当前会话（那是有意的 —— 以前把所有会话的都携在顶上，
   * 用户报过「弹得太频繁」），所以重启后停在默认对话时，别的会话里的
   * 未完成任务是看不到的。这里补一条**不抢焦点**的提示。
   *
   * ★ 只提示，**不自动接着跑** —— 文档里写着「不得直接盲目恢复执行」。
   *   你完全可能刚改过它要动的文件。
   */
  try {
    await useTaskStore.getState().refresh()
    const pending = useTaskStore.getState().unfinished
    if (pending.length > 0) {
      const dirty = pending.filter((item) => item.envChanged.length > 0).length
      useUIStore
        .getState()
        .showToast(
          'info',
          `上次有 ${pending.length} 条任务没做完`,
          dirty > 0
            ? `其中 ${dirty} 条要动的文件已经变过了 —— 点侧栏对话旁的黄点接着做`
            : '点侧栏对话旁的黄点可以接着做',
        )
    }
  } catch {
    /* 恢复清单读不到不影响启动 */
  }
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
