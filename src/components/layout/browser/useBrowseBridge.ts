import { useEffect, useRef } from 'react'
import { useBrowserStore, visibleTabOf, type PendingBrowse } from '@/stores/useBrowserStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAppStore } from '@/stores/useAppStore'
import { getActiveThread } from '@/stores/app/selectors'
import { browseNotice, isBrowseAction } from '@/lib/browseNotice'
import type { BrowserRequestEvent } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   接住主进程来的浏览请求

   `<webview>` 是渲染进程里的 DOM 元素，主进程碰不到 ——
   所以「Agent 用浏览器」要走一个往返：

     工具（主进程）→ browser:request → 这里 → 开标签 → 切到浏览器 tab
                                     → BrowserTab 读正文 → browser:result
                                                        → 主进程 resolve

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

      if (
        req.action === 'snapshot' ||
        req.action === 'click' ||
        req.action === 'type' ||
        req.action === 'nav'
      ) {
        /*
         * 读 / 点 / 打字 / 回退：都在**当前**这个标签里做，不开新标签（nav 走的是
         * 它自己的历史，见 useBrowserStore.requestBrowse 里的注释）。
         * 前提是浏览器里已经有打开的页面 —— 没有就直说，别让主进程干等 45 秒。
         *
         * 「有没有页面」按**本会话**看（真机反馈 6）：别的会话开着页面不算 ——
         * 那些页面拿不来给这个会话点/打字（可能完全是另一个站点）。
         */
        const { tabs, activeId } = useBrowserStore.getState()
        if (!visibleTabOf(tabs, sessionId, activeId)) {
          void window.workbench?.browserResult?.(req.id, {
            ok: false,
            error: '浏览器里还没有打开的页面，先 browse 打开一个网页',
          })
          return
        }
        useBrowserStore.getState().requestBrowse({
          id: req.id,
          action: req.action,
          url: '',
          index: req.index,
          text: req.text,
          pressEnter: req.pressEnter,
          authorized: req.authorized,
          direction: req.direction,
          sessionId,
        })
        useUIStore.getState().setActiveRightTab('browser')
        return
      }
      if (req.action !== 'navigate' || !req.url) return

      /*
       * 把请求放进 store —— BrowserTab 挂载后会消费它。
       * 同时把右侧切到「浏览器」：Agent 不该在用户看不见的地方偷偷开网页。
       */
      useBrowserStore.getState().requestBrowse({
        id: req.id,
        action: 'navigate',
        url: String(req.url),
        /* 透传「在当前标签里打开」—— AI 靠它压住标签的堆叠（见 tools/browse.cjs） */
        sameTab: req.sameTab === true,
        sessionId,
      })
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
  void window.workbench?.browserResult?.(pending.id, { ok: false, error: reason })
}
