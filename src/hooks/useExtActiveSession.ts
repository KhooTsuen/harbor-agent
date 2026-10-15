import { useEffect } from 'react'

/* ══════════════════════════════════════════════════════════════
   Phase 2：把「界面当前打开的会话」报给主进程

   为什么需要它：Edge 扩展读到的页面内容由**扩展进程**经命名管道送进主进程
   （见 electron/core/ext-bridge.cjs），主进程要决定它落进哪条会话 ——
   而「现在打开的是哪条」只有渲染层知道。

   为什么用 `?.` 两层：与 `browserActive` 同一个写法（见 useBrowseDriver.ts）——
   浏览器预览下 `window.workbench` 整个不存在，不该让界面炸。

   尽力而为：主进程没收到（或收到的那条已被删）会**新建一条专用会话**兜底。
   ══════════════════════════════════════════════════════════════ */

export function useExtActiveSession(activeThreadId: string): void {
  useEffect(() => {
    if (!activeThreadId) return
    /* 与 useBrowseDriver.ts:75 同一写法：拿不到桥就什么也不做，绝不让面板炸 */
    void window.workbench?.extActiveSession?.(activeThreadId)
  }, [activeThreadId])
}
