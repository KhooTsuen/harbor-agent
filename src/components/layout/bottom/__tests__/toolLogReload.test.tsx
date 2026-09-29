import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditEntry } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   运行日志**跟着新条目走**

   用户 2026-09-30 报的：「底栏的日志，只要它满了 200 条就不会再刷新了，
   他不会保持持续刷新（指有日志条目显示就更新一次）」。

   查下来跟 200 没关系 —— 列表取的就是最新 200 条。真凶是那个面板
   **只在打开时拉一次 + 手动点刷新**：面板开着、Agent 在跑，流水一条都不动。

   改事件驱动（工具跑完 bump 一次）。这里钉住：bump → 真的重新拉。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ calls: 0, entries: [] as unknown[] }))

vi.mock('@/lib/safetyApi', () => ({
  auditList: async () => {
    h.calls += 1
    return { entries: h.entries, days: [] }
  },
}))

const { ToolLogPanel } = await import('../ToolLogPanel')
const { useAuditStore } = await import('@/stores/useAuditStore')

function entry(tool: string): AuditEntry {
  return {
    ts: 1,
    sessionId: '',
    taskId: '',
    tool,
    permission: '',
    approval: null,
    startedAt: 1,
    finishedAt: 2,
    ms: 1,
    ok: true,
    error: '',
    affectedFiles: [],
    networkTarget: '',
    result: '',
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  h.calls = 0
  h.entries.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** 挂载 + 跑掉那条 120ms 的延迟 */
async function mount(): Promise<void> {
  act(() => {
    root.render(<ToolLogPanel />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
}

describe('运行日志 / 跟着新条目走', () => {
  it('★ 挂载时拉一次', async () => {
    await mount()
    expect(h.calls).toBe(1)
  })

  it('★ 工具跑完（bump）→ 重新拉一次，新条目出现在列表里', async () => {
    h.entries.push(entry('read_file'))
    await mount()
    expect(host.textContent).toContain('read_file')

    /* Agent 又干了一步 */
    h.entries.push(entry('run_shell'))
    act(() => useAuditStore.getState().bump())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    expect(h.calls).toBe(2)
    expect(host.textContent).toContain('run_shell')
  })

  it('连着 bump 只拉一次（并行工具同一刻完成，别反复读审计文件）', async () => {
    await mount()
    act(() => {
      useAuditStore.getState().bump()
      useAuditStore.getState().bump()
      useAuditStore.getState().bump()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(h.calls).toBe(2)
  })
})
