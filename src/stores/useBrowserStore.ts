import { create } from 'zustand'
import { sameUrl } from '@/lib/url'

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
  /**
   * 这个标签属于**哪个会话**（标签栏按会话隔离，真机反馈 6）。
   * 会话号就是 `Thread.id`；`''` = 还不知道属于谁（只会在测试里出现）。
   */
  sessionId: string
  /**
   * 谁开的这个标签。
   * `user`  = 在地址栏里自己开的：Agent 不许把它当成"自己那一个"拿去改地址；
   * `agent` = Agent 导航开出来的：同一个会话里永远只复用这一个（真机反馈 1b）。
   */
  owner: 'user' | 'agent'
  /**
   * 这个标签的 webview 重建计数（手动「重新加载」用）。
   * 放在**每个标签**上，不是全局一个 —— 以前全局一个，一重载就把当前 webview 换了；
   * 而标签常驻之后，全局值还会让切标签也跟着重建（见 BrowserTab 的注释）。
   */
  reloadKey: number
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
  /** type 时用：用户已明确授权填密码（由确认弹窗得到） */
  authorized?: boolean
  /**
   * 哪个会话发起的。渲染层从当前会话盖章（主进程发的事件里没有这个字段）。
   * 用来让 AI 在同一个会话里复用同一个标签 —— 见 `requestBrowse` 里的注释。
   */
  sessionId?: string
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
  /** Agent 请求读某个页面：开标签 + 交给 BrowserTab 执行 */
  requestBrowse: (request: PendingBrowse) => void
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

/**
 * 本会话的标签（真机反馈 6：标签栏按会话隔离）。
 *
 * 口径：`sessionId` 等于本会话，或者「还没认领归属的用户标签」——
 * 后者是兜底（地址栏建标签时还没来得及盖章），**别的会话的标签永远不会混进来**。
 * `visibleTabOf` 与 BrowserTab 的标签栏都调它，别各写一遍。
 */
export function tabsOfSession(
  tabs: readonly BrowserTabItem[],
  sessionId: string,
): BrowserTabItem[] {
  return tabs.filter((t) => t.sessionId === sessionId || (t.sessionId === '' && t.owner === 'user'))
}

/**
 * 当前该**显示**、也该被 Agent 驱动的那一个标签。
 *
 * 只看本会话的标签 —— 别的会话的标签留在 DOM 里继续活着，但不显示、也不被驱动。
 * 放在这里当**唯一口径**：BrowserTab（显示谁）、useBrowseBridge（判断「有没有页面」）、
 * useBrowseDriver（驱动哪个元素）三处都调它，不要各写一遍。
 */
export function visibleTabOf(
  tabs: readonly BrowserTabItem[],
  sessionId: string,
  activeId: string,
): BrowserTabItem | undefined {
  const mine = tabsOfSession(tabs, sessionId)
  return mine.find((t) => t.id === activeId) ?? mine[mine.length - 1]
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
      /* snapshot / click / type 都不导航、不开新标签：只操作当前已经打开的页面 */
      if (
        request.action === 'snapshot' ||
        request.action === 'click' ||
        request.action === 'type'
      ) {
        return queuedOf(state, request)
      }
      /*
       * 导航：**一个地址一个标签**（真机反馈 3 把上一版改回来了）。
       *
       * 中间试过「每个会话只留一个 Agent 标签」—— 那是错的：Agent 连读三个页面，
       * 用户只看得见最后一个，「它到底开了哪些网页」完全看不出来。
       * 现在一个地址一个标签，只是**按会话隔离**（别的会话的页面不摆在这条对话的标签栏里）。
       *
       * 「同一个地址」用 sameUrl 判，不用 `===`：Agent 给的地址写法不统一
       * （`example.com` 与 `example.com/`），严格比较会白开一个标签。
       */
      const sid = request.sessionId ?? ''
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
