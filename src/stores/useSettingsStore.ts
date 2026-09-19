import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FontFamilyId, ReasoningLevel, Settings, SettingsPatch } from '@/types'
import { LAYOUT } from '@/constants'
import { clamp } from '@/lib/utils'
import { useRealBackend, pushGeneral } from '@/lib/backend'
import { settingsToConfig } from '@/lib/configMapping'

/* ══════════════════════════════════════════════════════════════
   设置

   persist 到 localStorage。存进来的值都可能是脏的（用户手改、版本升级），
   所以 load 之后统一过一遍 normalize。
   ══════════════════════════════════════════════════════════════ */

export const DEFAULT_SETTINGS: Settings = {
  theme: 'default',
  fontScale: 100,
  fontFamily: 'system',
  customFontFamily: '',
  /** 侧栏上下分栏里，上半（对话文件夹）占的百分比 */
  sidebarFolderPercent: 45,

  /* 玻璃拟态默认关：实测参考实现没有毛玻璃，想看得自己开 */
  glassmorphism: false,
  animations: true,
  sidebarWidth: LAYOUT.sidebar.default,
  rightPanelWidth: LAYOUT.rightPanel.default,
  sidebarCollapsed: false,
  rightPanelVisible: true,
  defaultMode: 'pair',
  /** 空 = 用配置里的 assistant.model */
  defaultModel: '',
  defaultReasoning: 'high',
  defaultProjectId: '',
  sendOnEnter: true,
  typewriterSpeed: 1,
  language: 'zh',
  searchHistory: [],
  shortcutKeys: {},
  lastThreadId: '',
  lastRightTab: 'diff',
  lastBottomPanelOpen: false,
}

function normalize(input: Partial<Settings> | undefined): Settings {
  const s = input ?? {}
  const theme =
    s.theme === 'chatgpt' || s.theme === 'spec' || s.theme === 'light' || s.theme === 'system'
      ? s.theme
      : 'default'
  const mode =
    s.defaultMode === 'plan' || s.defaultMode === 'execute' || s.defaultMode === 'goal'
      ? s.defaultMode
      : 'pair'
  const reasoning: ReasoningLevel =
    s.defaultReasoning === 'low' || s.defaultReasoning === 'high' || s.defaultReasoning === 'max'
      ? s.defaultReasoning
      : 'high'

  const fontFamily: FontFamilyId =
    s.fontFamily === 'yahei' ||
    s.fontFamily === 'noto' ||
    s.fontFamily === 'harmony' ||
    s.fontFamily === 'custom'
      ? s.fontFamily
      : 'system'

  return {
    theme,
    fontScale: clamp(Number(s.fontScale) || 100, 80, 150),
    /*
     * 上下分栏比例。这里只做**粗略**兜底（5~95）——
     * 真正的限位在组件里按像素算（任何一栏都不能被挤成 0，否则手柄也跟着消失）。
     * 两边都夹会打架：之前这里夹 15~85，在 580px 高的列表里 15% = 87px，
     * 比组件的下限 76px 还大，于是「下限」变成了 87，看着像没夹住。
     */
    sidebarFolderPercent: clamp(Number(s.sidebarFolderPercent) || 45, 5, 95),
    fontFamily,
    customFontFamily: typeof s.customFontFamily === 'string' ? s.customFontFamily : '',
    lastThreadId: typeof s.lastThreadId === 'string' ? s.lastThreadId : '',
    lastRightTab:
      s.lastRightTab === 'terminal' ||
      s.lastRightTab === 'files' ||
      s.lastRightTab === 'browser' ||
      s.lastRightTab === 'artifacts' ||
      s.lastRightTab === 'tasks' ||
      s.lastRightTab === 'state'
        ? s.lastRightTab
        : 'diff',
    lastBottomPanelOpen: s.lastBottomPanelOpen === true,
    glassmorphism: s.glassmorphism === true,
    animations: s.animations !== false,
    sidebarWidth: clamp(
      Number(s.sidebarWidth) || LAYOUT.sidebar.default,
      LAYOUT.sidebar.min,
      LAYOUT.sidebar.max,
    ),
    rightPanelWidth: clamp(
      Number(s.rightPanelWidth) || LAYOUT.rightPanel.default,
      LAYOUT.rightPanel.min,
      LAYOUT.rightPanel.max,
    ),
    sidebarCollapsed: s.sidebarCollapsed === true,
    rightPanelVisible: s.rightPanelVisible !== false,
    defaultMode: mode,
    defaultModel: typeof s.defaultModel === 'string' ? s.defaultModel : '',
    defaultReasoning: reasoning,
    defaultProjectId: typeof s.defaultProjectId === 'string' ? s.defaultProjectId : '',
    sendOnEnter: s.sendOnEnter !== false,
    typewriterSpeed: clamp(Number(s.typewriterSpeed ?? 1), 0, 4),
    language: s.language === 'en' ? 'en' : 'zh',
    searchHistory: Array.isArray(s.searchHistory)
      ? s.searchHistory.filter((x) => typeof x === 'string').slice(0, 20)
      : [],
    shortcutKeys:
      s.shortcutKeys && typeof s.shortcutKeys === 'object'
        ? Object.fromEntries(
            Object.entries(s.shortcutKeys).filter(
              ([key, value]) => typeof key === 'string' && typeof value === 'string' && value,
            ),
          )
        : {},
  }
}

interface SettingsState {
  settings: Settings
  updateSettings: (patch: SettingsPatch) => void
  resetSettings: () => void
  /** 记一条搜索历史（去重、最新在前、最多 20 条） */
  addSearchHistory: (query: string) => void
  clearSearchHistory: () => void
  /** 用主进程读回来的配置覆盖本地设置 */
  syncFromConfig: (next: Settings) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      updateSettings: (patch) => {
        set((state) => ({ settings: normalize({ ...state.settings, ...patch }) }))
        /*
         * Electron 下配置以主进程的 data/config.json 为准。
         * 这里把「主进程也管的字段」回写，界面状态（宽度、折叠）不回写。
         * 不 await：UI 先走，落盘晚一点没关系。
         */
        if (useRealBackend) {
          const general = settingsToConfig(patch)
          if (Object.keys(general).length > 0) void pushGeneral(general)
        }
      },
      resetSettings: () => set({ settings: DEFAULT_SETTINGS }),

      addSearchHistory: (query) =>
        set((state) => {
          const text = query.trim()
          if (!text) return state
          const rest = state.settings.searchHistory.filter((x) => x !== text)
          return { settings: { ...state.settings, searchHistory: [text, ...rest].slice(0, 20) } }
        }),

      clearSearchHistory: () =>
        set((state) => ({ settings: { ...state.settings, searchHistory: [] } })),

      /** 启动时用主进程的配置覆盖本地（只覆盖它管的字段） */
      syncFromConfig: (next) => set({ settings: normalize(next) }),
    }),
    {
      name: 'personal-agent:settings',
      version: 1,
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as { settings?: Partial<Settings> }
        return { ...current, settings: normalize(incoming.settings) }
      },
    },
  ),
)

/** 组件外读设置（事件回调里用） */
export function getSettings(): Settings {
  return useSettingsStore.getState().settings
}
