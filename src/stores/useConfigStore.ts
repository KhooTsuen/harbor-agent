import { create } from 'zustand'
import type {
  AppConfig,
  ProviderConfig,
  ProviderConnectionResult,
  SceneConfig,
  SceneId,
} from '@/types/backend'
import {
  getWorkdir,
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
  /** 保存一段 general；返回**主进程是否真的落盘成功**（失败时调用方要能说出来） */
  patchGeneral: (patch: Partial<AppConfig['general']>) => Promise<boolean>
  patchAssistant: (patch: Partial<AppConfig['assistant']>) => Promise<boolean>
  patchTools: (patch: Partial<AppConfig['tools']>) => Promise<boolean>
  patchSearch: (patch: Partial<AppConfig['search']>) => Promise<boolean>
  patchAudit: (patch: Partial<AppConfig['audit']>) => Promise<boolean>
  patchLimits: (patch: Partial<AppConfig['limits']>) => Promise<boolean>
  patchMemory: (patch: Partial<AppConfig['memory']>) => Promise<boolean>
  patchContext: (patch: Partial<AppConfig['context']>) => Promise<boolean>
  patchRouter: (patch: Partial<AppConfig['router']>) => Promise<boolean>
  patchFallback: (patch: Partial<AppConfig['fallback']>) => Promise<boolean>
  patchMcp: (servers: AppConfig['mcp']['servers']) => Promise<boolean>
  patchScene: (id: SceneId, patch: Partial<SceneConfig>) => Promise<boolean>
  patchImage: (patch: Partial<AppConfig['image']>) => Promise<boolean>
  patchDownloads: (patch: Partial<AppConfig['downloads']>) => Promise<boolean>
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<boolean>
  addProvider: () => Promise<void>
  /** 一键加「ChatGPT Codex CLI（实验性）」后端 —— 老用户的 providers 数组里没有它 */
  addCodexProvider: () => Promise<void>
  removeProvider: (id: string) => Promise<void>
  chooseWorkdir: () => Promise<boolean>
  /**
   * 把「当前生效的工作目录」从主进程重新读一遍（手填了一条路径之后要它）。
   *
   * 为什么不能让界面自己猜：生效目录是**解析出来的**（没配就是 data/chat），
   * 只有主进程知道。手填保存成功后不读一次，「当前生效」那行就还显示旧值。
   */
  syncWorkdir: () => Promise<string>
  testProvider: (id?: string) => Promise<ProviderConnectionResult>
  /** 重置后端配置；返回是否真的成功（失败时调用方**不能**报「已重置」） */
  resetToDefaults: () => Promise<boolean>
}

function replaceProvider(
  list: readonly ProviderConfig[],
  id: string,
  patch: Partial<ProviderConfig>,
): ProviderConfig[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p))
}

export const useConfigStore = create<ConfigState>((set, get) => {
  /*
   * 保存一次配置改动，并把主进程**回给我们的那份**当成新状态。
   *
   * ── 为什么要有 `seq`（2026-10-31 第二阶段）────────────────────
   * 用户在输入框里连改两下（A → B），两次保存同时在飞。如果 A 的回包**后到**，
   * 「谁后到谁写进内存」就会把 B 的结果盖回成 A —— 界面显示 A，磁盘上是 B
   * （或者反过来，取决于谁后落盘）。这就是「快速连续修改后被较旧结果覆盖」。
   *
   * 规则：只有**最后一次发起的**那次结果能写进内存；更早的结果照样返回它的
   * 成功与否（调用方的提示要说真话），只是不许改 store。
   */
  let seq = 0
  async function apply(patch: Record<string, unknown>): Promise<boolean> {
    const mine = ++seq
    const config = await pushConfig(patch)
    if (!config) return false
    if (mine === seq) set({ config })
    return true
  }

  return {
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

    patchGeneral: (patch) => apply({ general: patch }),

    patchAssistant: (patch) => apply({ assistant: patch }),

    patchImage: (patch) => apply({ image: patch }),

    patchDownloads: (patch) => apply({ downloads: patch }),

    patchTools: (patch) => apply({ tools: patch }),

    patchSearch: (patch) => apply({ search: patch }),

    patchAudit: (patch) => apply({ audit: patch }),

    patchLimits: (patch) => {
      /*
       * ★ 用**最新**配置来合，不用调用方手里那份快照。
       *
       * 踩过：两个上限输入框先后失焦，各自把手里的 `limits` 快照整个交上来 ——
       * 后交的那份快照里另一个字段还是旧值，于是**先填的那个字段被写回去了**。
       * 用户看到的是「填了、也保存了，回头一看又空了」。
       */
      return apply({ limits: { ...get().config?.limits, ...patch } })
    },

    patchMemory: (patch) => apply({ memory: patch }),

    patchContext: (patch) => apply({ context: patch }),

    patchRouter: (patch) => apply({ router: patch }),

    patchFallback: (patch) => apply({ fallback: patch }),

    patchMcp: (servers) => apply({ mcp: { servers } }),

    patchScene: async (id, patch) => {
      const current = get().config
      if (!current) return false
      const next = { ...current.scenes, [id]: { ...current.scenes[id], ...patch } }
      return apply({ scenes: next })
    },

    updateProvider: async (id, patch) => {
      const current = get().config
      if (!current) return false
      /* 掩码值不能被写回去，否则真 key 会被一串圆点覆盖 */
      const safePatch = { ...patch }
      if (safePatch.apiKey === '••••••••') delete safePatch.apiKey

      const next = replaceProvider(current.providers, id, safePatch)
      return apply({ providers: next })
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
      await apply({ providers: next })
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
          /* 三个可选项一律留空 —— 与内核预设（`config-codex-preset.cjs`）保持同一形状。
             ★ 这里**不替用户预填**任何路径 / 代理地址 / 数据目录（自检钉住两处一致）。 */
          codexPath: '',
          proxy: '',
          codexHome: '',
        },
      ]
      await apply({ providers: next })
    },

    removeProvider: async (id) => {
      const current = get().config
      if (!current || current.providers.length <= 1) return
      await apply({ providers: current.providers.filter((p) => p.id !== id) })
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

    syncWorkdir: async () => {
      const dir = (await getWorkdir()) ?? ''
      set({ workdir: dir })
      if (dir) await useAppStore.getState().setWorkdir(dir)
      return dir
    },

    testProvider: async (id) => {
      return await pingProvider(id)
    },

    resetToDefaults: async () => {
      const config = await resetConfig()
      if (!config) return false
      set({ config })
      /* 重置之后生效目录可能变了（工作目录回到默认）—— 一并读回来 */
      await get().syncWorkdir()
      return true
    },
  }
})
