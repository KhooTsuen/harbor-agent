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
  sent: null as ({ requestId: string; requestTime?: number } & Record<string, unknown>) | null,
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
    sendChat: async (
      payload: { requestId: string; requestTime?: number } & Record<string, unknown>,
    ) => {
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
import { useThreadStore } from '../useThreadStore'

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
    /*
     * zustand 的 set 既能收对象也能收函数（turns.ts 用的是函数形式）。
     * 所以这里维护一份假 state 并求值，否则收尾那条记录会漏掉。
     */
    const setCalls: Array<{ sendingThreads?: string[] }> = []
    let fakeState = { sendingThreads: [] as string[] }
    const collect = (partial: unknown): void => {
      const next =
        typeof partial === 'function'
          ? (partial as (s: typeof fakeState) => { sendingThreads?: string[] })(fakeState)
          : (partial as { sendingThreads?: string[] })
      fakeState = { ...fakeState, ...next }
      setCalls.push(next)
    }

    const pending = runElectronTurn(threadId, 'hi', collect)
    /* 让 sendChat 的 Promise 落地 */
    await Promise.resolve()
    await Promise.resolve()

    /* 关键断言：sendChat 已经返回了，但界面仍应是「发送中」 */
    expect(h.sent).not.toBeNull()
    expect(setCalls.at(-1)?.sendingThreads).toContain(threadId)

    emitFromBackend({ type: 'done', content: '好的' })
    await pending

    expect(setCalls.at(-1)?.sendingThreads).toEqual([])
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

  it('主进程推 failed → 前端记下 phase（不再自己猜 status）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    /*
     * zustand 的 set 既能收对象也能收函数（turns.ts 用的是函数形式）。
     * 所以这里维护一份假 state 并求值，否则收尾那条记录会漏掉。
     */
    const setCalls: Array<{ sendingThreads?: string[] }> = []
    let fakeState = { sendingThreads: [] as string[] }
    const collect = (partial: unknown): void => {
      const next =
        typeof partial === 'function'
          ? (partial as (s: typeof fakeState) => { sendingThreads?: string[] })(fakeState)
          : (partial as { sendingThreads?: string[] })
      fakeState = { ...fakeState, ...next }
      setCalls.push(next)
    }

    const pending = runElectronTurn(threadId, 'hi', collect)
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'error', message: 'API Key 无效' })
    await pending

    expect(setCalls.at(-1)?.sendingThreads).toEqual([])
  })

  it('★ AG-001：phase 只由主进程的事件驱动', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    /* 主进程状态机推什么，前端就记什么 —— 渲染层不自己推断 */
    emitFromBackend({ type: 'phase', phase: 'executing' })
    await Promise.resolve()
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('executing')

    emitFromBackend({ type: 'phase', phase: 'failed' })
    await pending
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('failed')
  })

  it('收到 aborted 事件后正常收尾（不卡在发送中）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'aborted' })
    await pending

    expect(useThreadStore.getState().sendingThreads).not.toContain(threadId)
  })

  it('★ AG-003：按下发送那一瞬就置上 sendingThreads（不等 IPC 回来）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    h.sent = null
    /* 传真的 set（生产里 useThreadStore 传的就是它）—— 空函数不会更新 store，断言就没意义了 */
    void runElectronTurn(threadId, 'hi', useThreadStore.setState)

    /*
     * 这条断言的是**顺序**，不是时序。
     *
     * `runElectronTurn` 是 async，但从函数头到 `sendingThreads` 那一行之间
     * **一个 await 都没有**（已用测试钉住），所以它同步跑完这一段才让出执行权。
     * 也就是说：在 `void runElectronTurn(...)` 的下一行检查，就等于
     * 「主进程收到 IPC 之前」—— 那一刻 sendingThreads 必须已经置上了。
     *
     * 没有它，用户按完发送到收到第一个 `agent.started` 之间会面对一个
     * 毫无反应的界面。为什么不在真机上测：React 18 批处理状态更新，
     * 点完按钮那一刻 DOM 本来就没变，靠 DOM 时序区分不了「本地生效」和
     * 「主进程已回」。
     */
    expect(useThreadStore.getState().sendingThreads).toContain(threadId)

    await vi.waitFor(() => expect(h.sent).not.toBeNull())
    const sent = h.sent as { requestTime?: number } | null
    expect(sent?.requestTime).toBeGreaterThan(0)
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

  it('★ 重新生成：payload 要带 regenerateOf / regenerateIsLast（主进程挂台账、标旧事务用）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {}, '', {
      reason: '重新生成',
      regeneratedFrom: 'dk-old',
      regenerateIsLast: true,
    })
    await vi.waitFor(() => expect(h.sent).not.toBeNull())
    expect(h.sent?.regenerateOf).toBe('dk-old')
    expect(h.sent?.regenerateIsLast).toBe(true)
    expect(h.sent?.reason).toBe('重新生成')
    emitFromBackend({ type: 'done', content: 'ok' })
    await pending
  })
})
