import { create } from 'zustand'
import { sameUrl } from '@/lib/url'
import { agentTabOf, tabsOfSession, visibleTabOf, type BrowserTabItem } from './browserTabs'

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

   `BrowserTabItem` 与「本会话有哪些 / 显示谁 / 驱动谁」三个口径搬去了
   `browserTabs.ts`（这个文件之前过 300 行了）。这里转出去，老引用照旧。
   ══════════════════════════════════════════════════════════════ */

export { tabsOfSession, visibleTabOf, agentTabOf }
export type { BrowserTabItem }

/** 主进程发来、还没被执行的一次浏览请求 */
export interface PendingBrowse {
  id: string
  /** navigate=导航读正文；snapshot=读元素；click=点；type=打字；nav=历史后退/前进；wcid=取 webContents id */
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'nav' | 'wcid'
  url: string
  /** click / type 时用：目标元素索引（snapshot 返回的 i） */
  index?: number
  /** type 时用：要输入的文字 */
  text?: string
  /** type 时用：输入后要不要回车 */
  pressEnter?: boolean
  /** type 时用：用户已明确授权填密码（由确认弹窗得到） */
  authorized?: boolean
  /** click 时用：落点被遮挡也强制点（工具侧 `browse_click(index, force: true)`） */
  force?: boolean
  /**
   * 哪个会话发起的。渲染层从当前会话盖章（主进程发的事件里没有这个字段）。
   * 用来让 AI 在同一个会话里复用同一个标签 —— 见 `requestBrowse` 里的注释。
   */
  sessionId?: string
  /** nav 时用：往哪个方向走（back 上一页 / forward 下一页） */
  direction?: 'back' | 'forward'
  /**
   * navigate 时用：在当前那个**属于 Agent 的**标签里打开，不开新标签
   * （工具侧 `browse(url, sameTab: true)`）。见 requestBrowse 里的 sameTab 分支。
   */
  sameTab?: boolean
}

interface BrowserState {
  tabs: BrowserTabItem[]
  activeId: string
  /** 正在处理的那一条（driver 只看它） */
  pending: PendingBrowse | null
  /** 排队等着处理的（先进先出；一条干完由 `clearPending` 接上下一条） */
  queue: PendingBrowse[]
  /**
   * Agent 最后一次动网页的时刻（0 = 还没动过）。
   *
   * 为什么放在 store：要显示角标的是右栏**标签栏**，而收到请求的是
   * `useBrowseBridge`（同一个组件里，但标签栏要能单独订阅）——
   * 而且用户点开浏览器标签看一下之后角标就该减掉。
   */
  agentAt: number

  open: (url: string, sessionId?: string) => void
  select: (id: string) => void
  close: (id: string) => void
  reload: () => void
  /** Agent 请求读某个页面：开标签 + 交给 BrowserTab 执行（B5 后只 navigate 走它） */
  requestBrowse: (request: PendingBrowse) => void
  /** Agent 要操作某个标签：把它选出来（只切 activeId，不开新标签，也不碰用户的标签） */
  selectAgentTab: (sessionId: string) => void
  /** BrowserTab 处理完了 */
  clearPending: () => void
  /** Agent 动了网页（点/读/打字）——点亮右栏「浏览器」标签上的角标 */
  markAgentActivity: () => void
  /** 用户自己点开浏览器标签看过了 —— 角标减掉 */
  clearAgentActivity: () => void
  /** 关标签：传会话号就只关那个会话的，不传就全关 */
  closeAll: (sessionId?: string) => void
}

function newTabId(): string {
  return `tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/**
 * 新请求进队：**正在跑的那条不动**，后来的排到队尾（真机反馈）。
 *
 * 为什么不是「后来的顶掉前面的」：Agent 一口气开三个网页是很常见的动作，
 * 顶掉就等于前两个白干（主进程那边只能等到超时），用户看到的是「它一次只开一个」。
 * 排队不丢，而且顺序跟它请求的一致。
 */
function queuedOf(
  state: { pending: PendingBrowse | null; queue: PendingBrowse[] },
  request: PendingBrowse,
): { pending?: PendingBrowse; queue?: PendingBrowse[] } {
  return state.pending ? { queue: [...state.queue, request] } : { pending: request }
}

export const useBrowserStore = create<BrowserState>()((set) => ({
  tabs: [],
  activeId: '',
  pending: null,
  queue: [],
  agentAt: 0,

  /**
   * 用户自己开一个标签。
   * `sessionId` 由调用方（BrowserTab）从当前会话取 —— 标签栏按会话隔离靠它。
   */
  open: (url, sessionId) =>
    set((state) => {
      const id = newTabId()
      return {
        tabs: [...state.tabs, { id, url, sessionId: sessionId ?? '', owner: 'user', reloadKey: 0 }],
        activeId: id,
      }
    }),

  select: (id) => set({ activeId: id }),
  close: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id)
      const activeId = state.activeId === id ? (tabs[tabs.length - 1]?.id ?? '') : state.activeId
      return { tabs, activeId }
    }),

  /* 只重建**当前标签**那个 webview（以前全局一个值，一重载就把当前那个换了） */
  reload: () =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === state.activeId ? { ...t, reloadKey: t.reloadKey + 1 } : t,
      ),
    })),

  requestBrowse: (request) =>
    set((state) => {
      const sid = request.sessionId ?? ''

      /*
       * ★ B5（2026-10-09）：只有 `navigate`（开 / 复用标签）会走到这里 —— 其余动作
       * （snapshot/click/type/nav/wcid）主进程拿着 webContentsId 经 CDP 直连做了，
       * 不再进 store。所以下面只剩「导航」这一条路。
       *
       * 导航 + sameTab：在**当前那个 Agent 标签**里打开，不开新的 ——
       * 这就是「中转页别占标签位」的落地（工具侧 `browse(url, sameTab: true)`）。
       * 两个讲究：
       *   · 只认 `owner === 'agent'` 的标签 —— 用户自己开的那个不许拿来改地址。
       *   · **不改 reloadKey**（不重建 webview）：靠重渲染把 src 换成新地址，
       *     这样这个标签的**历史留着**，之后 `browse_nav back` 才退得回来。
       * 本会话没有 Agent 标签时落到下面开新标签（不拿用户的顶替）。
       */
      if (request.sameTab) {
        const mine = agentTabOf(state.tabs, sid, state.activeId)
        if (mine) {
          const same = sameUrl(mine.url, request.url ?? '')
          return {
            tabs: state.tabs.map((t) =>
              t.id === mine.id ? { ...t, url: same ? t.url : (request.url ?? t.url) } : t,
            ),
            activeId: mine.id,
            ...queuedOf(state, request),
          }
        }
      }

      /*
       * 导航：**一个地址一个标签**（真机反馈 3 把上一版改回来了）。
       *
       * 中间试过「每个会话只留一个 Agent 标签」—— 那是错的：Agent 连读三个页面，
       * 用户只看得见最后一个，「它到底开了哪些网页」完全看不出来。
       * 现在一个地址一个标签，只是**按会话隔离**（别的会话的页面不摆在这条对话的标签栏里）。
       * 「同一个地址」用 sameUrl 判，不用 `===`：Agent 给的地址写法不统一
       * （`example.com` 与 `example.com/`），严格比较会白开一个标签。
       */
      const existing = state.tabs.find(
        (t) => sameUrl(t.url, request.url ?? '') && (t.sessionId === '' || t.sessionId === sid),
      )
      if (existing) {
        const same = sameUrl(existing.url, request.url ?? '')
        return {
          tabs: state.tabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  /* 地址没真的变就不动它（动一下 React 就会重新导一次） */
                  url: same ? t.url : (request.url ?? t.url),
                  sessionId: t.sessionId || sid,
                  /* 地址真的变了才重建 webview；同地址复用不重建（不白重新加载） */
                  reloadKey: same ? t.reloadKey : t.reloadKey + 1,
                }
              : t,
          ),
          activeId: existing.id,
          ...queuedOf(state, request),
        }
      }
      const id = newTabId()
      return {
        tabs: [
          ...state.tabs,
          { id, url: request.url ?? '', sessionId: sid, owner: 'agent', reloadKey: 0 },
        ],
        activeId: id,
        ...queuedOf(state, request),
      }
    }),

  /*
   * Agent 要操作某个标签（B5）：把它选出来即可，不开新标签、不碰用户的标签。
   * 主进程经 CDP 直连那个 webview 做真正的动作，这里只管界面上的「选中」。
   */
  selectAgentTab: (sessionId) =>
    set((state) => {
      const mine = agentTabOf(state.tabs, sessionId, state.activeId)
      return mine && mine.id !== state.activeId ? { activeId: mine.id } : {}
    }),

  /*
   * 这一条干完了：把排队的下一条接上来（先进先出）。
   * 队列空就真的清空 —— driver 盯的是 `pending`，它一变就接着跑下一条。
   */
  clearPending: () =>
    set((state) => {
      const [next, ...rest] = state.queue
      return { pending: next ?? null, queue: rest }
    }),

  markAgentActivity: () => set({ agentAt: Date.now() }),
  clearAgentActivity: () => set({ agentAt: 0 }),

  /*
   * 关标签。传会话号就只关那个会话的（真机反馈 6：一个会话收尾不该把别的会话
   * 正在看的页面也关掉）；不传就全关（收尾 / 测试用）。
   * 关掉的会话正好有请求在跑时把 pending 清掉 —— driver 的 cleanup 会据此**当面回话**，
   * 不让主进程干等 45 秒超时（见 useBrowseDriver 里那段注释）。
   */
  closeAll: (sessionId) =>
    set((state) => {
      if (!sessionId) return { tabs: [], activeId: '', pending: null, queue: [], agentAt: 0 }
      const tabs = state.tabs.filter((t) => t.sessionId !== sessionId)
      return {
        tabs,
        activeId: tabs.some((t) => t.id === state.activeId) ? state.activeId : '',
        pending: state.pending?.sessionId === sessionId ? null : state.pending,
        queue: state.queue.filter((item) => item.sessionId !== sessionId),
      }
    }),
}))
