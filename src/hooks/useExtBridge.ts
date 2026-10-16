import { useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { stopActiveRequest } from '@/stores/thread/turnControl'

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

/**
 * 主进程发来的**指令**形状（见 `core/ext-chat.cjs`）。
 *
 * 两条走同一条 `chat:event` 通道（**不是**新 IPC 通道）：
 *   · `ext:send` —— 发一条消息，可能指定「侧边栏选中的那条」
 *   · `ext:new`  —— 新建一条会话并切过去（侧边栏顶栏那个 ＋）
 *   · `ext:abort`—— M02-A2：请渲染层**真正**停掉那条会话正在跑的一轮（停止按钮）
 */
interface ExtCommand {
  type?: string
  sessionId?: string
  text?: string
  /** true = 侧边栏一个会话都没选中，请新建一条再发（Phase 3c） */
  newSession?: boolean
}

/**
 * 侧边栏来的三条指令（`ext:*`）—— `ext:abort` 只是「请你去停」，名字容易误解成
 * 「已经停了」。所以这里写清：**真正 abort 的是渲染层**（它手里有 AbortController）。
 */

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

  /*
   * Phase 3c：侧边栏发来的**指令** —— 两条。
   *
   *   · `ext:send` 发一条消息。**可能指定了「侧边栏选中的那条会话」**。
   *   · `ext:new`  新建一条会话并切过去（顶栏那个 ＋）。
   *
   * ★ 为什么指定会话时必须先 `hydrateThread`：`sendMessage` 组 history 读的是内存里
   *   的 `messages` —— 那条会话没读过就是空数组，**模型只看得见刚那一句**（上下文全丢）。
   *   所以发之前先把它的消息从磁盘装进来。
   *
   * ★ 为什么不干脆 `openFromDisk` 切过去：用户 2026-10-16 拍板「侧边栏独立看一条，
   *   主窗口不动」—— 切过去就等于动了主窗口（那是用户明确不要的）。
   *
   * ★ 为什么用 `onEvent` 订：`subscribeChatEvents` 是**每一轮内部**建的
   *   （见 `thread/turns.ts`），而这两条恰恰是「还没有轮次」时来的。
   */
  useEffect(() => {
    const off = window.workbench?.onEvent?.((raw) => {
      const event = raw as ExtCommand
      if (!event) return

      if (event.type === 'ext:new') {
        const id = useAppStore.getState().createThread()
        useAppStore.getState().setActiveThread(id)
        return
      }

      /*
       * M02-A2：侧边栏点了「停止」—— 真正的中断在这里发生。
       *
       * ★ 为什么必须由渲染层做：只有它手里有那一轮的 AbortController。调的是
       *   `stopActiveRequest`（`thread/turnControl.ts`）—— **唯一一处**真正 abort 的
       *   实现：它会先收掉挂在这条对话上的澄清卡 / 权限卡（不然主进程干等到超时，
       *   被当成「用户离场」按默认选项继续），再 abort 请求、拆掉兜底时钟。
       *   不另写一套（硬约束 #9）。
       *
       * 传 threadId（= sessionId）：只停那一条；不传会把所有在跑的对话都停掉。
       */
      if (event.type === 'ext:abort') {
        const tid = String(event.sessionId ?? '')
        if (!tid) return
        stopActiveRequest(tid)
        return
      }

      if (event.type !== 'ext:send') return
      const text = String(event.text ?? '')
      if (!text) return

      if (event.newSession) {
        /* 侧边栏一条都没选中 → 新建一条再发（用户拍板：两侧都要出现这条） */
        const id = useAppStore.getState().createThread()
        useAppStore.getState().setActiveThread(id)
        useThreadStore.getState().sendMessage(text)
        return
      }

      const sessionId = String(event.sessionId ?? '')
      if (!sessionId || sessionId === useAppStore.getState().activeThreadId) {
        useThreadStore.getState().sendMessage(text)
        return
      }

      /* 侧边栏在看**另一条** → 后台对那条跑一轮（主窗口不动） */
      const ensureLoaded = async (): Promise<void> => {
        /* 不在内存列表里先刷新一次（它可能是主窗口 load 之后才建的） */
        if (!useAppStore.getState().threads.some((t) => t.id === sessionId)) {
          await useAppStore.getState().loadFromDisk()
        }
        await useAppStore.getState().hydrateThread(sessionId)
      }
      void ensureLoaded().then(() => {
        useThreadStore.getState().sendMessage(text, undefined, sessionId)
      })
    })
    return off
  }, [])
}
