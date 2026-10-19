import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   Phase 5：长耗时命令 / 强制中断并发

   复现「后端任务已经成功，对话 UI 却卡在运行中/中断」的两条路 —— 从 turns.test.ts
   拆出来（那边贴着 300 行红线）。定位与证据见
   docs/research/phase5-turn-lifecycle-design.md。

   被测的四点：A1 收尾写终态 phase / A2 兜底超时真叫停 / A3 停止拆看门狗 / B1 心跳不误杀。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
  sent: null as ({ requestId: string; requestTime?: number } & Record<string, unknown>) | null,
  abortCalled: 0,
}))

/* 只覆盖对话这四个（其余保留真导出，useAppStore 那一串还依赖它们） */
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
    sendChat: async (payload: { requestId: string } & Record<string, unknown>) => {
      h.sent = payload
      return { ok: true, requestId: payload.requestId }
    },
    abortChat: async () => {
      h.abortCalled += 1
      return true
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/*
 * 静默阈值取 250ms（真机是 5 分钟）—— 留足余量：测试启动 + `sleep(10)` 之后才开始
 * 发心跳，250ms 的窗口足够宽，不会因为测试机抖动误触发。
 */
const SILENCE = 250

describe('Phase 5：一轮收尾的生命周期（长命令 / 中断并发）', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    h.listeners = []
    h.sent = null
    h.abortCalled = 0
  })

  it('★ 长命令有心跳 → 兜底不误杀，最终照常回 idle', async () => {
    const threadId = useAppStore.getState().activeThreadId
    void runElectronTurn(threadId, 'hi', useThreadStore.setState, '', { turnSilenceMs: SILENCE })
    await sleep(10)
    emitFromBackend({ type: 'phase', phase: 'executing' })

    /* 模拟一条长命令：每 50ms 一次心跳，持续 400ms（远超 250ms 静默线） */
    for (let i = 0; i < 8; i += 1) {
      await sleep(50)
      emitFromBackend({
        type: 'agent.tool.progress',
        toolCallId: 't1',
        name: 'run_shell',
        note: '命令还在跑',
      })
    }
    /* ① 没被误判成卡死：没叫停、还在跑 */
    expect(h.abortCalled).toBe(0)
    expect(useThreadStore.getState().sendingThreads).toContain(threadId)

    /* ② 命令结束 → done → 正常回 idle（phase=completed） */
    emitFromBackend({ type: 'done', content: '完成' })
    await vi.waitFor(() => expect(useThreadStore.getState().sendingThreads).not.toContain(threadId))
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('completed')
  })

  it('★ 真静默超阈值 → 叫停主进程 + 收口 phase（不再永久卡「运行中」）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    void runElectronTurn(threadId, 'hi', useThreadStore.setState, '', { turnSilenceMs: SILENCE })
    await sleep(10)
    emitFromBackend({ type: 'phase', phase: 'executing' })
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('executing')

    /* 一个字都不来 → 兜底时钟到点：A2 真叫停主进程、A1 收口 phase=failed */
    await vi.waitFor(() => expect(h.abortCalled).toBeGreaterThan(0), { timeout: 3000 })
    await vi.waitFor(() =>
      expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('failed'),
    )
    expect(useThreadStore.getState().sendingThreads).not.toContain(threadId)
  })

  it('★ 强制中断并发 —— 停止后终态 phase + 队列不死锁', async () => {
    const threadId = useAppStore.getState().activeThreadId
    void runElectronTurn(threadId, 'hi', useThreadStore.setState)
    await vi.waitFor(() => expect(h.sent).not.toBeNull())
    emitFromBackend({ type: 'phase', phase: 'executing' })

    useThreadStore.getState().stopGeneration()
    /* 停止请求已送达，但在收到终态前仍须保持「在跑」。 */
    expect(h.abortCalled).toBeGreaterThan(0)
    expect(useThreadStore.getState().sendingThreads).toContain(threadId)

    /* 主进程回执 aborted → ① phase 进终态 */
    emitFromBackend({ type: 'aborted' })
    await vi.waitFor(() =>
      expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe(
        'cancelled',
      ),
    )
    expect(useThreadStore.getState().sendingThreads).not.toContain(threadId)

    /* ④ 停止之后还能再发一条（队列不死锁） */
    h.sent = null
    void useThreadStore.getState().sendMessage('再来一条')
    await vi.waitFor(() => expect(h.sent).not.toBeNull())
  })

  it('★ 停止后兜底时钟被拆掉（不会过一会儿把已停的那轮标成 error）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    void runElectronTurn(threadId, 'hi', useThreadStore.setState, '', { turnSilenceMs: SILENCE })
    await sleep(10)
    emitFromBackend({ type: 'phase', phase: 'executing' })

    useThreadStore.getState().stopGeneration()
    const abortsAfterStop = h.abortCalled
    emitFromBackend({ type: 'aborted' })
    await sleep(SILENCE + 200) // 远超静默线

    expect(h.abortCalled).toBe(abortsAfterStop) // 看门狗没再叫停
    expect(useAppStore.getState().threads.find((t) => t.id === threadId)?.phase).toBe('cancelled')
  })
})
