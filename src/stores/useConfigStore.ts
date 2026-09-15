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
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<void>
  addProvider: () => Promise<void>
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
    const config = await pushConfig({ limits: patch })
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
