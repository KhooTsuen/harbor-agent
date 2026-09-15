import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   turns.ts 的时序测试

   这里锁住一个真实踩过的坑：
   sendChat 是主进程**立刻返回**的（agent 循环在后台跑），
   所以不能在它返回后就取消事件订阅 —— 那样 done 事件全丢，
   界面上永远停在「正在处理」。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
  sent: null as { requestId: string } | null,
  abortCalled: 0,
}))

/*
 * 保留 backend 的真实导出（useAppStore 那一串还依赖它们），只覆盖对话这四个。
 * 全部自己写的话会漏 —— 第一次跑就漏了 disk.ts 要用的那些函数。
 */
vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    useRealBackend: true,
    subscribeChatEvents: (callback: (event: Record<string, unknown>) => void) => {
      h.listeners.push(callback)
      return () => {
        const index = h.listeners.indexOf(callback)
        if (index >= 0) h.listeners.splice(index, 1)
      }
    },
    sendChat: async (payload: { requestId: string }) => {
      h.sent = payload
      return { ok: true, requestId: payload.requestId }
    },
    abortChat: async () => {
      h.abortCalled += 1
    },
    confirmChat: async () => {},
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { runElectronTurn } from '@/stores/thread/turns'

/** 模拟主进程推一个事件回来 */
function emitFromBackend(event: Record<string, unknown>): void {
  const requestId = h.sent?.requestId ?? ''
  for (const listener of [...h.listeners]) listener({ requestId, ...event })
}

describe('runElectronTurn', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    h.listeners = []
    h.sent = null
    h.abortCalled = 0
  })

  it('sendChat 返回后不能立刻收尾，要等 done', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const setCalls: Array<{ sending?: boolean }> = []

    const pending = runElectronTurn(threadId, 'hi', (partial) => setCalls.push(partial))
    /* 让 sendChat 的 Promise 落地 */
    await Promise.resolve()
    await Promise.resolve()

    /* 关键断言：sendChat 已经返回了，但界面仍应是「发送中」 */
    expect(h.sent).not.toBeNull()
    expect(setCalls.at(-1)?.sending).toBe(true)

    emitFromBackend({ type: 'done', content: '好的' })
    await pending

    expect(setCalls.at(-1)?.sending).toBe(false)
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.status).toBe('success')
  })

  it('收到 content 事件后消息内容逐步长出来', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'content', text: '你' })
    emitFromBackend({ type: 'content', text: '好' })

    const streaming = useAppStore
      .getState()
      .threads.find((t) => t.id === threadId)
      ?.messages.find((m) => m.status === 'streaming')
    expect(streaming?.content).toBe('你好')

    emitFromBackend({ type: 'done', content: '你好' })
    await pending
  })

  it('收到 error 事件后收尾，状态是 error', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const setCalls: Array<{ sending?: boolean }> = []

    const pending = runElectronTurn(threadId, 'hi', (partial) => setCalls.push(partial))
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'error', message: 'API Key 无效' })
    await pending

    expect(setCalls.at(-1)?.sending).toBe(false)
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.status).toBe('error')
  })

  it('收到 aborted 事件后收尾，状态为 cancelled', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'aborted' })
    await pending

    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.status).toBe('cancelled')
  })

  it('done 之后订阅要取消掉，不留监听', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    expect(h.listeners.length).toBe(1)
    emitFromBackend({ type: 'done', content: 'ok' })
    await pending

    expect(h.listeners.length).toBe(0)
  })
})
