import { create } from 'zustand'
import type { PermissionRequest, RightTab, Toast, ToastKind } from '@/types'
import type { TaskOutcome } from '@/types/notify'
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
  /**
   * 正在跑的生图任务 —— 界面用它显示实时进度。
   * 生图是异步的（上游排队 + 出图要几十秒到几分钟），主进程每 3 秒推一次状态。
   */
  imageTask: { taskId: string; sessionId?: string; status?: string; elapsedMs: number } | null
  setImageTask: (
    task: { taskId: string; sessionId?: string; status?: string; elapsedMs: number } | null,
  ) => void
  commandPaletteOpen: boolean
  searchQuery: string
  permission: PermissionRequest | null
  toasts: Toast[]
  /**
   * AG-042 控制台要用：底部面板（日志 / 终端）的开合与当前视图。
   * 原来这是 App.tsx 里的局部 state —— 任务行里的「查看 Tool」够不着它。
   */
  bottomPanelOpen: boolean
  bottomPanelView: 'log' | 'terminal'
  setBottomPanelOpen: (open: boolean) => void
  /** 打开底部面板并切到指定视图（「查看 Tool」就是打开日志流水） */
  openBottomPanel: (view: 'log' | 'terminal') => void

  /**
   * AG-033：任务刚结束、给用户几个「下一步」入口。
   * 只认**当前这条对话**（threadId 对不上就不显示），点一个或关掉就清。
   * AG-034：带的是「这一轮到底干了什么」（改了几个文件 / 测试跑没跑过），
   * 入口据此挑，而不是一份固定清单。
   */
  nextSteps: { threadId: string; outcome: TaskOutcome } | null

  toggleRightPanel: () => void
  setRightPanelVisible: (visible: boolean) => void
  setActiveRightTab: (tab: RightTab) => void
  /** 打开设置。给 tab 就直接落在那一页（「调整权限」要落在「权限与安全」上） */
  openSettings: (tab?: string) => void
  /** 打开设置时想直接落到哪一页；没指定就是空 */
  settingsTab: string | null
  closeSettings: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setSearchQuery: (q: string) => void

  showToast: (
    kind: ToastKind,
    title: string,
    description?: string,
    action?: Toast['action'],
  ) => string
  hideToast: (id: string) => void

  setNextSteps: (value: { threadId: string; outcome: TaskOutcome } | null) => void
  askPermission: (request: PermissionRequest) => void
  closePermission: () => void
}

export const useUIStore = create<UIState>((set) => ({
  rightPanelVisible: true,
  activeRightTab: 'diff',
  settingsOpen: false,
  settingsTab: null,
  imageTask: null,
  commandPaletteOpen: false,
  searchQuery: '',
  permission: null,
  bottomPanelOpen: false,
  bottomPanelView: 'log',
  toasts: [],
  nextSteps: null,

  toggleRightPanel: () => set((s) => ({ rightPanelVisible: !s.rightPanelVisible })),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab, rightPanelVisible: true }),
  setImageTask: (task) => set({ imageTask: task }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  closeSettings: () => set({ settingsOpen: false }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  showToast: (kind, title, description, action) => {
    const id = uid('toast')
    const toast: Toast = {
      id,
      kind,
      title,
      ...(description ? { description } : {}),
      ...(action ? { action } : {}),
    }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    return id
  },

  hideToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  openBottomPanel: (view) => set({ bottomPanelOpen: true, bottomPanelView: view }),

  setNextSteps: (value) => set({ nextSteps: value }),

  askPermission: (request) => set({ permission: request }),
  closePermission: () => set({ permission: null }),
}))
