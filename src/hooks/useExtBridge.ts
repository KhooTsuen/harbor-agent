import { useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   Phase 2：浏览器扩展桥（**双向**，缺一半都不算通）

   ① **上报**：把「界面当前打开的会话」报给主进程。
      为什么需要：Edge 扩展读到的页面内容由**扩展进程**经命名管道送进主进程
      （见 electron/core/ext-bridge.cjs），主进程要决定它落进哪条会话 ——
      而「现在打开的是哪条」只有渲染层知道。

   ② **接收**：订阅 `ext:page`，收到就刷新界面。
      为什么需要：那条内容是**扩展进程 → 命名管道 → 主进程**直接写进会话文件的，
      渲染层全程不知情。**没有这一步，用户点完「读当前页」界面上什么都不会变**，
      得手动切一下会话才看得见（Phase 2 真机验收时逮到的缺口，不是猜的）。

   ── Phase 3b：多了一条 `ext:send`（侧边栏发来的消息）────────────────
   侧边栏点「发送」→ 主进程校验（忙 / 没窗口 / 没会话）→ 推 `chat:event`
   + `type: 'ext:send'` → **这里接住，调 `sendMessage`**。
   为什么必须是这里（而不是主进程自己跑）：assistant 的落盘**只在渲染层**
   （`replyPersistence.ts`）—— 主进程自己跑就没有它，回复不落盘。
   所以这一路是「转给渲染层跑」，与用户手打**同一条路**。

   订阅**不能用 `subscribeChatEvents`**：那条订阅是**每一轮内部**建的
   （见 `thread/turns.ts` 的 `off = subscribeChatEvents(...)`），
   没有活跃轮次时根本没人听 —— 而 `ext:send` 恰恰是「还没有轮次」时来的。

   为什么用 `?.` 两层：与 `browserActive` 同一个写法（见 useBrowseDriver.ts）——
   浏览器预览下 `window.workbench` 整个不存在，不该让界面炸。
   ══════════════════════════════════════════════════════════════ */

/** `ext:send` 的载荷形状（主进程发的，见 core/ext-chat.cjs） */
interface ExtSendEvent {
  type?: string
  sessionId?: string
  text?: string
}

export function useExtBridge(activeThreadId: string): void {
  useEffect(() => {
    if (!activeThreadId) return
    /* 与 useBrowseDriver.ts:75 同一写法：拿不到桥就什么也不做，绝不让面板炸 */
    void window.workbench?.extActiveSession?.(activeThreadId)
  }, [activeThreadId])

  useEffect(() => {
    const off = window.workbench?.onExtPage?.((event) => {
      const store = useAppStore.getState()
      /*
       * 顺序不能反：先刷新列表（兜底新建的会话才会出现在侧栏里），再重读那条会话。
       *
       * 用事件里的 `sessionId`（不用「当前 activeThreadId」）：内容落进的是**主进程
       * 认定的**那条会话 —— 没报过 / 报的那条被删时它会新建一条兜底会话，
       * 这时只有跟着 sessionId 切过去，用户才看得到内容。
       * `openFromDisk` 有「读盘期间没人动过 messages 才允许覆盖」的守卫
       * （见 stores/app/diskActions.ts），`loadFromDisk` 恰好保住引用，所以它过得去。
       */
      void store.loadFromDisk().then(() => store.openFromDisk(event.sessionId))
    })
    return off
  }, [])

  /* Phase 3b：侧边栏发来的消息 —— 切到那条会话，然后照常发（与用户手打同一条路） */
  useEffect(() => {
    const off = window.workbench?.onEvent?.((raw) => {
      const event = raw as ExtSendEvent
      if (!event || event.type !== 'ext:send') return
      const text = String(event.text ?? '')
      if (!text) return
      const sessionId = String(event.sessionId ?? '')
      const store = useAppStore.getState()
      const send = () => useThreadStore.getState().sendMessage(text)
      if (sessionId && sessionId !== store.activeThreadId) {
        /* 侧边栏看的是另一条会话 → 先切过去（否则消息会落进用户眼前这条） */
        void store
          .loadFromDisk()
          .then(() => store.openFromDisk(sessionId))
          .then(send)
        return
      }
      send()
    })
    return off
  }, [])
}
