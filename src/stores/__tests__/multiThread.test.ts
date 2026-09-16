import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   多对话并行

   用户报的：a 对话在跑任务时，b 对话发不出消息。

   根因是 `useThreadStore` 里的 `sending` 是个**全局开关** ——
   a 在跑时所有对话的发送按钮都被禁用、`sendMessage` 也被挡。

   后端其实一直是并发的（每个请求一个 AbortController、确认弹窗按 id 存），
   所以这是纯前端的问题。现在改成按「这条对话在不在跑」判断。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
  sent: [] as Array<{ requestId: string }>,
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    useRealBackend: true,
    /* 新建对话会先落盘建会话 —— 给个假的，让流程能往下走 */
    createSession: async () => ({ id: 'sess_test' }),
    subscribeChatEvents: (callback: (event: Record<string, unknown>) => void) => {
      h.listeners.push(callback)
      return () => {
        const index = h.listeners.indexOf(callback)
        if (index >= 0) h.listeners.splice(index, 1)
      }
    },
    sendChat: async (payload: { requestId: string }) => {
      h.sent.push(payload)
      return { ok: true }
    },
    abortChat: async () => {},
    confirmChat: async () => {},
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'

/** 切到某条对话、打一句话、点发送 */
function sendFrom(threadId: string, text: string): void {
  useAppStore.getState().setActiveThread(threadId)
  useThreadStore.setState({ input: text })
  useThreadStore.getState().sendMessage()
}

describe('多对话并行', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    useThreadStore.setState({ sendingThreads: [], input: '', inputImages: [] })
    h.sent = []
  })

  it('★ a 在跑时，b 照样能发出去', async () => {
    const app = useAppStore.getState()
    const a = app.createThread()
    const b = app.createThread()

    /* a 正在跑 */
    useAppStore.getState().setThreadStatus(a, 'running')

    sendFrom(b, '你好')

    await vi.waitFor(() => expect(h.sent.length).toBe(1))
    expect(h.sent[0]?.requestId).toBeTruthy()
  })

  it('同一条对话在跑时，重复发送会被挡住', () => {
    const a = useAppStore.getState().createThread()
    useAppStore.getState().setThreadStatus(a, 'running')

    sendFrom(a, '再来一次')

    /* 没有新请求发出去 */
    expect(h.sent.length).toBe(0)
  })

  it('空闲的对话不受影响（回归）', async () => {
    const b = useAppStore.getState().createThread()
    sendFrom(b, '你好')
    await vi.waitFor(() => expect(h.sent.length).toBe(1))
  })

  it('sendingThreads 是按对话记的，不是全局一个布尔', () => {
    const app = useAppStore.getState()
    const a = app.createThread()
    const b = app.createThread()

    useThreadStore.setState((s) => ({
      sendingThreads: [...s.sendingThreads, a],
    }))

    const list = useThreadStore.getState().sendingThreads
    expect(list).toContain(a)
    expect(list).not.toContain(b)
  })
})
