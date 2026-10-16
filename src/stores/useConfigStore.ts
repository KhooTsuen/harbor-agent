import { create } from 'zustand'
import type { AppConfig, ProviderConfig, SceneConfig, SceneId } from '@/types/backend'
import {
  isElectron,
  loadConfig,
  pingProvider,
  pickWorkdir,
  pushConfig,
  resetConfig,
} from '@/lib/backend'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   主进程配置

   和 useSettingsStore 的分工：
     · useSettingsStore —— 纯界面状态（主题、玻璃、布局宽度），localStorage
     · useConfigStore   —— 真后端配置（供应商、助手、工具权限、工作目录），主进程

   浏览器预览没有桌面配置桥；完整配置功能只在 Electron 桌面版提供。
   ══════════════════════════════════════════════════════════════ */

interface ConfigState {
  config: AppConfig | null
  /** 是否读过了（区分「还没读」和「读了但是空」） */
  loaded: boolean
  loading: boolean
  workdir: string

  reload: () => Promise<void>
  patchGeneral: (patch: Partial<AppConfig['general']>) => Promise<void>
  patchAssistant: (patch: Partial<AppConfig['assistant']>) => Promise<void>
  patchTools: (patch: Partial<AppConfig['tools']>) => Promise<void>
  patchSearch: (patch: Partial<AppConfig['search']>) => Promise<void>
  patchAudit: (patch: Partial<AppConfig['audit']>) => Promise<void>
  patchLimits: (patch: Partial<AppConfig['limits']>) => Promise<void>
  patchMemory: (patch: Partial<AppConfig['memory']>) => Promise<void>
  patchContext: (patch: Partial<AppConfig['context']>) => Promise<void>
  patchRouter: (patch: Partial<AppConfig['router']>) => Promise<void>
  patchFallback: (patch: Partial<AppConfig['fallback']>) => Promise<void>
  patchMcp: (servers: AppConfig['mcp']['servers']) => Promise<void>
  patchScene: (id: SceneId, patch: Partial<SceneConfig>) => Promise<void>
  patchImage: (patch: Partial<AppConfig['image']>) => Promise<void>
  patchDownloads: (patch: Partial<AppConfig['downloads']>) => Promise<void>
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<void>
  addProvider: () => Promise<void>
  /** 一键加「ChatGPT Codex CLI（实验性）」后端 —— 老用户的 providers 数组里没有它 */
  addCodexProvider: () => Promise<void>
  removeProvider: (id: string) => Promise<void>
  chooseWorkdir: () => Promise<boolean>
  testProvider: (id?: string) => Promise<{ ok: boolean; model?: string; error?: string }>
  resetToDefaults: () => Promise<void>
}

function replaceProvider(
  list: readonly ProviderConfig[],
  id: string,
  patch: Partial<ProviderConfig>,
): ProviderConfig[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p))
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loaded: false,
  loading: false,
  workdir: '',

  reload: async () => {
    if (!isElectron) {
      set({ loaded: true })
      return
    }
    set({ loading: true })
    const config = await loadConfig()
    set({ config, loaded: true, loading: false })
  },

  patchGeneral: async (patch) => {
    const config = await pushConfig({ general: patch })
    if (config) set({ config })
  },

  patchAssistant: async (patch) => {
    const config = await pushConfig({ assistant: patch })
    if (config) set({ config })
  },

  patchImage: async (patch) => {
    const config = await pushConfig({ image: patch })
    if (config) set({ config })
  },

  patchDownloads: async (patch) => {
    const config = await pushConfig({ downloads: patch })
    if (config) set({ config })
  },

  patchTools: async (patch) => {
    const config = await pushConfig({ tools: patch })
    if (config) set({ config })
  },

  patchSearch: async (patch) => {
    const config = await pushConfig({ search: patch })
    if (config) set({ config })
  },

  patchAudit: async (patch) => {
    const config = await pushConfig({ audit: patch })
    if (config) set({ config })
  },

  patchLimits: async (patch) => {
    /*
     * ★ 用**最新**配置来合，不用调用方手里那份快照。
     *
     * 踩过：两个上限输入框先后失焦，各自把手里的 `limits` 快照整个交上来 ——
     * 后交的那份快照里另一个字段还是旧值，于是**先填的那个字段被写回去了**。
     * 用户看到的是「填了、也保存了，回头一看又空了」。
     */
    const config = await pushConfig({ limits: { ...get().config?.limits, ...patch } })
    if (config) set({ config })
  },

  patchMemory: async (patch) => {
    const config = await pushConfig({ memory: patch })
    if (config) set({ config })
  },

  patchContext: async (patch) => {
    const config = await pushConfig({ context: patch })
    if (config) set({ config })
  },

  patchRouter: async (patch) => {
    const config = await pushConfig({ router: patch })
    if (config) set({ config })
  },

  patchFallback: async (patch) => {
    const config = await pushConfig({ fallback: patch })
    if (config) set({ config })
  },

  patchMcp: async (servers) => {
    const config = await pushConfig({ mcp: { servers } })
    if (config) set({ config })
  },

  patchScene: async (id, patch) => {
    const current = get().config
    if (!current) return
    const next = { ...current.scenes, [id]: { ...current.scenes[id], ...patch } }
    const config = await pushConfig({ scenes: next })
    if (config) set({ config })
  },

  updateProvider: async (id, patch) => {
    const current = get().config
    if (!current) return
    /* 掩码值不能被写回去，否则真 key 会被一串圆点覆盖 */
    const safePatch = { ...patch }
    if (safePatch.apiKey === '••••••••') delete safePatch.apiKey

    const next = replaceProvider(current.providers, id, safePatch)
    const config = await pushConfig({ providers: next })
    if (config) set({ config })
  },

  addProvider: async () => {
    const current = get().config
    if (!current) return
    const id = `provider-${Date.now().toString(36)}`
    const next: ProviderConfig[] = [
      ...current.providers,
      {
        id,
        name: '新供应商',
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        chatPath: '/chat/completions',
        models: ['gpt-4o-mini'],
        enabled: true,
        hasKey: false,
      },
    ]
    const config = await pushConfig({ providers: next })
    if (config) set({ config })
  },

  /**
   * 一键加 Codex CLI 后端（实验性）。
   *
   * 为什么需要它：`config-normalize.cjs` 只在「用户配置里**没有** providers」时才用默认
   * 列表 —— 已有用户的 config.json 里早就有 providers 数组，新预设**不会**自动出现。
   * 没有这个入口，老用户根本选不到 Codex 后端（验收标准「能在模型设置里选它」不成立）。
   *
   * ★ 默认 `enabled: true`：用户点「添加」就是要用它。
   * ★ **没有任何凭据字段** —— 推理用 CLI 自己的登录态（Harbor 不碰 ChatGPT 凭据）。
   */
  addCodexProvider: async () => {
    const current = get().config
    if (!current) return
    /* 已经有了就不重复加（连点两下不该出现两个 Codex 后端） */
    if (current.providers.some((p) => p.kind === 'codex-cli')) return
    const next: ProviderConfig[] = [
      ...current.providers,
      {
        id: 'codex-cli',
        name: 'ChatGPT Codex CLI（实验性）',
        kind: 'codex-cli',
        /* 走 CLI 不走 HTTP：两个都空是**有意的**，不是漏填 */
        baseUrl: '',
        apiKey: '',
        credentialRef: '',
        chatPath: '/chat/completions',
        models: ['codex-cli'],
        enabled: true,
        hasKey: false,
      },
    ]
    const config = await pushConfig({ providers: next })
    if (config) set({ config })
  },

  removeProvider: async (id) => {
    const current = get().config
    if (!current || current.providers.length <= 1) return
    const config = await pushConfig({ providers: current.providers.filter((p) => p.id !== id) })
    if (config) set({ config })
  },

  chooseWorkdir: async () => {
    const result = await pickWorkdir()
    if (result.ok && result.workdir) {
      set({ workdir: result.workdir })
      await get().reload()
      /*
       * 同步给 appStore —— 会话列表和右栏文件树都挂在它的 workdir 上。
       * 以前漏了这一步，结果「切换工作目录」只改了配置，界面纹丝不动。
       */
      await useAppStore.getState().setWorkdir(result.workdir)
      return true
    }
    return false
  },

  testProvider: async (id) => {
    return await pingProvider(id)
  },

  resetToDefaults: async () => {
    const config = await resetConfig()
    if (config) set({ config })
  },
}))
