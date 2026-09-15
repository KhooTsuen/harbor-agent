import { create } from 'zustand'
import type { PermissionRequest, RightTab, Toast, ToastKind } from '@/types'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   界面状态

   布局相关的值（宽度/折叠）放在 useSettingsStore 里持久化，
   这里只放「临时」的东西：开了哪个面板、当前标签、弹窗、toast。
   ══════════════════════════════════════════════════════════════ */

interface UIState {
  rightPanelVisible: boolean
  activeRightTab: RightTab
  settingsOpen: boolean
  commandPaletteOpen: boolean
  searchQuery: string
  permission: PermissionRequest | null
  toasts: Toast[]

  toggleRightPanel: () => void
  setRightPanelVisible: (visible: boolean) => void
  setActiveRightTab: (tab: RightTab) => void
  openSettings: () => void
  closeSettings: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setSearchQuery: (q: string) => void

  showToast: (kind: ToastKind, title: string, description?: string) => string
  hideToast: (id: string) => void

  askPermission: (request: PermissionRequest) => void
  closePermission: () => void
}

export const useUIStore = create<UIState>((set) => ({
  rightPanelVisible: true,
  activeRightTab: 'diff',
  settingsOpen: false,
  commandPaletteOpen: false,
  searchQuery: '',
  permission: null,
  toasts: [],

  toggleRightPanel: () => set((s) => ({ rightPanelVisible: !s.rightPanelVisible })),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab, rightPanelVisible: true }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  showToast: (kind, title, description) => {
    const id = uid('toast')
    const toast: Toast = description ? { id, kind, title, description } : { id, kind, title }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    return id
  },

  hideToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  askPermission: (request) => set({ permission: request }),
  closePermission: () => set({ permission: null }),
}))
