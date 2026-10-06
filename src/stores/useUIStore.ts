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

  /** 彩蛋：/harbor 本地统计面板 */
  harborStatsOpen: boolean
  openHarborStats: () => void
  closeHarborStats: () => void

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
  /**
   * 收起权限卡（写操作确认）。
   *
   * 传了 `confirmId` 就**只关那一条**：主进程推来的「这张卡超时作废了」
   * （`confirm.timeout`）可能已经是上一张了 —— 无条件关会把用户正在答的那张清掉。
   * 这条是 2026-10-07 补的：以前只能无条件清，而超时那条路根本没人清，
   * 卡就在界面上烂着，还把后面所有澄清卡挡死（见 `confirmEvents.onConfirmTimeout`）。
   */
  closePermission: (confirmId?: string) => void
  /**
   * 主动收掉权限卡，**并把「拒绝」回给内核**。
   *
   * 和 `cancelClarify` 对称，用在「切对话」「停任务」两条路径上：卡不能跟着用户
   * 跑到别的对话里，也不能让主进程干等到 5 分钟超时（那会被当成用户离场）。
   * 与 `closePermission` 的区别：那个只是「把界面收起来」，不动内核。
   */
  cancelPermission: (confirmId?: string) => void
  /**
   * AG-053：澄清卡（开工前问的几个问题）。
   *
   * 和 `permission` 分开存、由 `lib/clarify.ts` 仲裁谁显示 —— 两者**不叠**：
   * 权限那条往返有 5 分钟超时（超时=拒绝），所以权限优先，澄清排队
   * （组件照旧挂着，只是用 hidden 收起来，省得用户勾了一半的选项被清空）。
   */
  clarify: PermissionRequest | null
  askClarify: (request: PermissionRequest) => void
  /**
   * 收起澄清卡。
   *
   * 传了 `confirmId` 就**只关那一条**：超时事件是主进程推上来的（他走开了），
   * 而它可能在界面上已经换成了下一张卡 —— 无条件关会把用户正在答的那张清掉。
   */
  closeClarify: (confirmId?: string) => void
  /**
   * 主动收掉澄清卡，**并把「不批」回给内核**（2026-10-04，小尾巴 #4）。
   *
   * 用在「切对话」「停任务」两条路径上：卡不能跟着用户跑到别的对话里（它是共享的
   * 一份 UI 状态），也不能让主进程干等到 5 分钟超时（那会被当成用户离场，
   * 按默认选项自己开工 —— 而用户只是走开了、或者把任务停了）。
   *
   * 与 `closeClarify` 的区别：那个只是「把界面收起来」，不动内核。
   */
  cancelClarify: (confirmId?: string) => void
  /**
   * P1-3：用户点了「需要你确认」的系统通知 → 请求把正在等他的那张卡**亮一下**
   * （聚焦到卡片的第一个可点项 + 滚进视野）。
   *
   * 用递增的 nonce 而不是布尔：卡片那边只需要「又收到一次请求」这个事实，
   * 不用管上一次有没有消费掉；也避免为它写一套复位逻辑。
   */
  cardFocusNonce: number
  requestCardFocus: () => void
}

export const useUIStore = create<UIState>((set, get) => ({
  rightPanelVisible: true,
  activeRightTab: 'diff',
  settingsOpen: false,
  settingsTab: null,
  imageTask: null,
  commandPaletteOpen: false,
  searchQuery: '',
  permission: null,
  clarify: null,
  cardFocusNonce: 0,
  bottomPanelOpen: false,
  bottomPanelView: 'log',
  toasts: [],
  nextSteps: null,
  harborStatsOpen: false,

  openHarborStats: () => set({ harborStatsOpen: true }),
  closeHarborStats: () => set({ harborStatsOpen: false }),

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
  closePermission: (confirmId) =>
    set((s) => (confirmId && s.permission?.confirmId !== confirmId ? {} : { permission: null })),
  cancelPermission: (confirmId) => {
    const cur = get().permission
    /* 传了 id 就只收那一条（和 cancelClarify 一个道理） */
    if (!cur || (confirmId && cur.confirmId !== confirmId)) return
    set({ permission: null })
    /* 先收界面再回话：回话里可能抛（IPC 断了），界面不能因此留在那儿 */
    cur.onCancel?.()
  },
  askClarify: (request) => set({ clarify: request }),
  closeClarify: (confirmId) =>
    set((s) => (confirmId && s.clarify?.confirmId !== confirmId ? {} : { clarify: null })),
  cancelClarify: (confirmId) => {
    const cur = get().clarify
    /* 传了 id 就只收那一条（主进程推来的收卡事件可能对应已经换掉的上一张） */
    if (!cur || (confirmId && cur.confirmId !== confirmId)) return
    set({ clarify: null })
    /* 先收界面再回话：回话里可能抛（IPC 断了），界面不能因此留在那儿 */
    cur.onCancel?.()
  },
  requestCardFocus: () => set((s) => ({ cardFocusNonce: s.cardFocusNonce + 1 })),
}))
