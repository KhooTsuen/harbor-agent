import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   浏览器标签的状态

   为什么**必须**放到 store 里，而不是 BrowserTab 里的 useState：

   Agent 的 `browse` 工具要能自己把标签页打开（不然用户得先手动点开
   右侧「浏览器」，Agent 才能读网页 —— 那是很差的体验）。

   而「接请求」的地方（RightPanel，一直挂着）和「操作 webview」的地方
   （BrowserTab，切过去才挂）**不是一个组件**。

   ⚠️ 这个坑今天踩过一次：`useBulkSelect` 内部用 useState，
   被两个组件各调一次就各拿一份状态，功能静默失效。
   **一个状态只要会被两处读写，就不能放在组件里。**
   ══════════════════════════════════════════════════════════════ */

export interface BrowserTabItem {
  id: string
  url: string
}

/** 主进程发来、还没被执行的一次浏览请求 */
export interface PendingBrowse {
  id: string
  /** navigate=导航读正文；snapshot=读元素；click=点；type=打字（后三个不导航） */
  action: 'navigate' | 'snapshot' | 'click' | 'type'
  url: string
  /** click / type 时用：目标元素索引（snapshot 返回的 i） */
  index?: number
  /** type 时用：要输入的文字 */
  text?: string
  /** type 时用：输入后要不要回车 */
  pressEnter?: boolean
}

interface BrowserState {
  tabs: BrowserTabItem[]
  activeId: string
  /** 换一个值就强制重建 webview（重载用） */
  reloadKey: number
  /** Agent 要读的页面 —— BrowserTab 挂载后会消费掉它 */
  pending: PendingBrowse | null

  open: (url: string) => void
  select: (id: string) => void
  close: (id: string) => void
  reload: () => void
  /** Agent 请求读某个页面：开标签 + 交给 BrowserTab 执行 */
  requestBrowse: (request: PendingBrowse) => void
  /** BrowserTab 处理完了 */
  clearPending: () => void
  closeAll: () => void
}

function newTabId(): string {
  return `tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export const useBrowserStore = create<BrowserState>()((set) => ({
  tabs: [],
  activeId: '',
  reloadKey: 0,
  pending: null,

  open: (url) =>
    set((state) => {
      const id = newTabId()
      return { tabs: [...state.tabs, { id, url }], activeId: id }
    }),

  select: (id) => set({ activeId: id }),
  close: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id)
      const activeId = state.activeId === id ? (tabs[tabs.length - 1]?.id ?? '') : state.activeId
      return { tabs, activeId }
    }),

  reload: () => set((state) => ({ reloadKey: state.reloadKey + 1 })),

  requestBrowse: (request) =>
    set((state) => {
      /* snapshot / click / type 都不导航、不开新标签：只操作当前已经打开的页面 */
      if (
        request.action === 'snapshot' ||
        request.action === 'click' ||
        request.action === 'type'
      ) {
        return { pending: request }
      }
      /*
       * 已经有同一个地址的标签就复用它 —— 不然 Agent 读三次同一个页面
       * 会开出三个标签，用户看着莫名其妙。
       */
      const existing = state.tabs.find((t) => t.url === request.url)
      if (existing) return { activeId: existing.id, pending: request }
      const id = newTabId()
      return {
        tabs: [...state.tabs, { id, url: request.url }],
        activeId: id,
        pending: request,
      }
    }),

  clearPending: () => set({ pending: null }),

  closeAll: () => set({ tabs: [], activeId: '', pending: null }),
}))
