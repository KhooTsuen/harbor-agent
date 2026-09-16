import { useEffect, useRef } from 'react'
import { useBrowserStore, type PendingBrowse } from '@/stores/useBrowserStore'
import { useUIStore } from '@/stores/useUIStore'
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

  useEffect(() => {
    const bridge = window.workbench
    if (!bridge?.onBrowserRequest) return

    const off = bridge.onBrowserRequest((req: BrowserRequestEvent) => {
      if (req.action === 'snapshot' || req.action === 'click' || req.action === 'type') {
        /*
         * 读/点/打字：操作当前页面，不导航。
         * 前提是浏览器里已经有打开的页面 —— 没有就直说，别让主进程干等 45 秒。
         */
        const { activeId } = useBrowserStore.getState()
        if (!activeId) {
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
        })
        useUIStore.getState().setActiveRightTab('browser')
        return
      }
      if (req.action !== 'navigate' || !req.url) return

      /*
       * 把请求放进 store —— BrowserTab 挂载后会消费它。
       * 同时把右侧切到「浏览器」：Agent 不该在用户看不见的地方偷偷开网页。
       */
      useBrowserStore
        .getState()
        .requestBrowse({ id: req.id, action: 'navigate', url: String(req.url) })
      useUIStore.getState().setActiveRightTab('browser')
      toastRef.current('info', '正在用浏览器读取网页', String(req.url))
    })

    return off
  }, [])
}

/** 万一 BrowserTab 一直没挂上（比如右侧面板被折叠了），别让主进程一直等 */
export function failPending(reason: string): void {
  const pending: PendingBrowse | null = useBrowserStore.getState().pending
  if (!pending) return
  useBrowserStore.getState().clearPending()
  void window.workbench?.browserResult?.(pending.id, { ok: false, error: reason })
}
