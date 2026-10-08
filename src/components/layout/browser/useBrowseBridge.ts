import { useEffect, useRef } from 'react'
import { useBrowserStore, type PendingBrowse } from '@/stores/useBrowserStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAppStore } from '@/stores/useAppStore'
import { getActiveThread } from '@/stores/app/selectors'
import { browseNotice, isBrowseAction } from '@/lib/browseNotice'
import type { BrowserRequestEvent } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   接住主进程来的浏览请求

   `<webview>` 是渲染进程里的 DOM 元素，主进程碰不到 ——
   所以「Agent 用浏览器」里，**开标签**这一步必须走渲染层；其余动作（读正文 /
   读元素 / 点 / 打字 / 换历史）主进程拿着 webContentsId 经 CDP 直连做了（B5）：

     navigate：工具（主进程）→ browser:request → 这里 → 开/复用标签 → 切到浏览器 tab
                                                              → BrowserTab 导航、等就绪
                                                              → browser:active → 主进程读正文
     其余动作：工具（主进程）→ browser:request → 这里只点亮界面（角标 / 选中 agent 标签）
                                  主进程**不等回话**，同时已经在直连做了

   **这个 hook 挂在 RightPanel 上（一直挂着的那个），不是 BrowserTab。**
   因为请求来的时候浏览器标签可能根本没开 —— 挂在 BrowserTab 里就没人接，
   而 Agent 该做的是**自己把标签打开**（用户能看见它在读哪个页面，
   这正是选「用可见标签」的意义）。

   真正操作 webview 的部分在 BrowserTab（它挂载后才能拿到元素）。
   ══════════════════════════════════════════════════════════════ */

export function useBrowseBridge(): void {
  const toastRef = useRef(useUIStore.getState().showToast)
  toastRef.current = useUIStore((s) => s.showToast)

  /*
   * 上一条提示的键（见 `lib/browseNotice.ts`）。
   * 用 ref 不用 state：这只是一次去重记录，变了不需要重渲染。
   */
  const lastNoticeRef = useRef('')

  useEffect(() => {
    const bridge = window.workbench
    if (!bridge?.onBrowserRequest) return

    const off = bridge.onBrowserRequest((req: BrowserRequestEvent) => {
      /*
       * 这次请求属于哪个会话 —— **渲染层自己盖章**（主进程发来的事件里没有这个字段）。
       * 用「用户当前正在看的那个会话」：AI 请求开浏览器时，界面就切在它上面。
       * 它决定 AI 在浏览器里复用哪一个标签（每个会话一个，见 useBrowserStore）。
       *
       * 注意 thread.id **就是**会话号（真后端下两者同一个值，见 setThreadMode 里
       * `updateSessionMeta(id, …)` 的写法）；Thread 上没有单独的 sessionId 字段。
       */
      const sessionId = getActiveThread(useAppStore.getState())?.id ?? ''
      /*
       * 「Agent 在用浏览器」写在界面上。
       *
       * 为什么必须有：browse 三个动作（读元素 / 点 / 打字）在界面上的表现
       * **只有**右侧面板悄悄切到「浏览器」标签 —— 用户在看对话时完全不知道
       * 发生了什么（小尾巴 #8）。所以：① 右边标签上点个角标；② 说一句话。
       */
      if (isBrowseAction(req.action)) {
        useBrowserStore.getState().markAgentActivity()
        const { key, notice } = browseNotice(
          lastNoticeRef.current,
          req.action,
          String(req.url ?? ''),
        )
        lastNoticeRef.current = key
        if (notice) toastRef.current(notice.level, notice.title, notice.detail)
      }

      if (req.action === 'navigate') {
        /*
         * 把请求放进 store —— BrowserTab 挂载后会消费它（开标签 / 换当前标签的地址）。
         * 同时把右侧切到「浏览器」：Agent 不该在用户看不见的地方偷偷开网页。
         */
        if (!req.url) return
        useBrowserStore.getState().requestBrowse({
          id: req.id,
          action: 'navigate',
          url: String(req.url),
          /* 透传「在当前标签里打开」—— AI 靠它压住标签的堆叠（见 tools/browse.cjs） */
          sameTab: req.sameTab === true,
          sessionId,
        })
        useUIStore.getState().setActiveRightTab('browser')
        return
      }

      /*
       * 其余动作（读元素 / 点 / 打字 / 换历史 / 取 wcid）：**主进程已经拿着 wcid
       * 经 CDP 直连做了**（B5）—— 这条 request 只是给界面看的：点亮角标、把 Agent
       * 那个标签选出来、面板切到浏览器。这里**不设 pending、不回话**，主进程没在等。
       */
      useBrowserStore.getState().selectAgentTab(sessionId)
      useUIStore.getState().setActiveRightTab('browser')
    })

    return off
  }, [])

  /*
   * 网页里弹新窗口（`window.open` / `target=_blank`）：主进程不给它真窗口，
   * 而是把地址转过来 —— 在这里开成一个**本会话的标签页**，并切到浏览器。
   * 用户要的就是"链接能开新标签"（2026-10-06 拍板）。
   */
  useEffect(() => {
    const bridge = window.workbench
    if (!bridge?.onBrowserOpenTab) return
    return bridge.onBrowserOpenTab((url) => {
      const target = String(url ?? '')
      if (!/^https?:\/\//i.test(target)) return
      const sessionId = getActiveThread(useAppStore.getState())?.id ?? ''
      useBrowserStore.getState().open(target, sessionId)
      useUIStore.getState().setActiveRightTab('browser')
    })
  }, [])
}

/** 万一 BrowserTab 一直没挂上（比如右侧面板被折叠了），别让主进程一直等 */
export function failPending(reason: string): void {
  const pending: PendingBrowse | null = useBrowserStore.getState().pending
  if (!pending) return
  useBrowserStore.getState().clearPending()
  void window.workbench?.browserActive?.({
    requestId: pending.id,
    sessionId: pending.sessionId ?? '',
    ok: false,
    error: reason,
  })
}
