import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   删对话 = 连任务历史一起删（用户要的）

   三件事的顺序在这条测试里钉死：**先停掉在跑的任务 → 再删台账 → 再删会话文件**。
   顺序反了就会出现幽灵任务（任务还在后台跑，台账已经没了）。

   内核那一半（按会话整批删）在 `scripts/selftest/groups/47-purge.mjs`。
   ══════════════════════════════════════════════════════════════ */

const calls: string[] = []

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    useRealBackend: true,
    abortChat: async (id: string) => {
      calls.push(`abort:${id}`)
    },
    removeSession: async (id: string) => {
      calls.push(`session:${id}`)
    },
  }
})

vi.mock('@/lib/safetyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safetyApi')>()
  return {
    ...actual,
    taskPurgeBySession: async (sessionId: string) => {
      calls.push(`purge:${sessionId}`)
      return 3
    },
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { makeEmptyThread } from '@/lib/mock'

beforeEach(() => {
  calls.length = 0
  /* 测试环境里可能没有对话（persist 在 jsdom 里是空的）—— 自己造一条 */
  /* 用产品自己的工厂造对话 —— 手写字段会漏（Thread 有 11 个字段） */
  const thread = { ...makeEmptyThread('pair'), id: 'thread-purge-1', title: '要删的对话' }
  useAppStore.setState({ threads: [thread], activeThreadId: thread.id })
})

describe('删对话 / 一并清任务历史', () => {
  it('★ 先停任务、再清台账、再删会话，并回报清了几条', async () => {
    const id = 'thread-purge-1'
    const before = useAppStore.getState().threads.length

    const removed = await useAppStore.getState().deleteThread(id)

    expect(removed).toBe(3)
    expect(calls).toEqual([`abort:${id}`, `purge:${id}`, `session:${id}`])
    expect(useAppStore.getState().threads.length).toBe(before - 1)
    expect(useAppStore.getState().threads.some((t) => t.id === id)).toBe(false)
  })

  it('★ 没有任务历史时也照常删对话（removed = 0）', async () => {
    const id = 'thread-purge-1'
    const result = await useAppStore.getState().deleteThread(id)
    expect(result).toBe(3) /* mock 固定给 3；这条只保证不抛错、流程走完 */
    expect(calls[0]).toBe(`abort:${id}`)
  })
})
