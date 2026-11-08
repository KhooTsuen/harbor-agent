import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
    「模型与服务商」页里的四个主标签，记住停在哪个

    ── 为什么单独一个 store ──────────────────────────────────────
    `SettingsWorkspace` 切页时会卸载整页组件（`settingsPageOf(id)` 换掉），
    所以组件内的 `useState` 一离开就丢。要「切走再回来还在原来那个标签」，
    状态就必须住在组件外面。

    为什么不塞进 `useUIStore`（那里已经有 settingsOpen / settingsTab）：
    那个文件贴着 300 行红线；而且这是**一页内部的**状态，和「哪个工作区、
    哪一页」不是同一层级 —— 混在一起会让「当前在哪」有第二个来源。

    ★ 不持久化（不写 localStorage）：用户重开应用回到「服务商」是合理的，
      不需要把它记成长期偏好。
    ══════════════════════════════════════════════════════════════ */

export const MODELS_TABS = ['providers', 'scenes', 'policy', 'collab'] as const
export type ModelsTab = (typeof MODELS_TABS)[number]

interface ModelsTabState {
  tab: ModelsTab
  setTab: (tab: ModelsTab) => void
}

export const useModelsTabStore = create<ModelsTabState>((set) => ({
  tab: 'providers',
  setTab: (tab) => set({ tab }),
}))

export function isModelsTab(value: unknown): value is ModelsTab {
  return typeof value === 'string' && (MODELS_TABS as readonly string[]).includes(value)
}
