import { useEffect, useState } from 'react'
import { preloadWorkspaceUi } from '@/components/layout/lazyAppParts'
import { getWorkdir, useRealBackend } from '@/lib/backend'
import { configToSettings } from '@/lib/configMapping'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProfileStore } from '@/stores/useProfileStore'
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

  /*
   * 把**当前这条对话**的消息读出来。
   *
   * 之前只有「点侧栏某条对话」才会读消息（setActiveThread 里那个懒加载），
   * 启动时只设了 activeThreadId —— 于是重启后打开应用，当前对话是**空的**，
   * 得先点别的对话再点回来才看得到历史（真机实测：磁盘上 2 条消息，
   * 启动后消息条数 0；点一下侧栏变 2）。
   *
   * 消息是懒加载的（见 stores/app/disk.ts 开头），所以这里只读一条。
   */
  const activeId = useAppStore.getState().activeThreadId
  if (activeId) await useAppStore.getState().openFromDisk(activeId)

  await preloadWorkspaceUi()

  /*
   * AG-012：如果上次有没做完的任务，**让用户知道**。
   *
   * AG-028：对话顶部那条横幅撤掉之后，这里是唯一的入口提示 —— 它不抢焦点，
   * 只把用户指到右栏「任务」标签（那里能看状态、接着做、放弃）。
   *
   * ★ 只提示，**不自动接着跑** —— 文档里写着「不得直接盲目恢复执行」。
   *   你完全可能刚改过它要动的文件。
   */
  try {
    await useTaskStore.getState().refresh()
    /* 个人资料（侧栏左下角那个圆）—— 名字与头像都在主进程那边 */
    await useProfileStore.getState().load()
    const pending = useTaskStore.getState().unfinished
    if (pending.length > 0) {
      const dirty = pending.filter((item) => item.envChanged.length > 0).length
      useUIStore
        .getState()
        .showToast(
          'info',
          `上次有 ${pending.length} 条任务没做完`,
          dirty > 0
            ? `其中 ${dirty} 条要动的文件已经变过了 —— 右栏「任务」里可以接着做`
            : '右栏「任务」标签里可以接着做',
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
