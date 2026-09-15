import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   useAppStore 的 action 测试

   每个用例前 resetAll，避免用例之间串状态。
   ══════════════════════════════════════════════════════════════ */

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
  })

  it('初始有示例项目', () => {
    const state = useAppStore.getState()
    expect(state.projects.length).toBeGreaterThan(0)
    expect(state.threads.length).toBeGreaterThan(0)
  })

  it('新建线程后进入列表并激活', () => {
    const id = useAppStore.getState().createThread()
    const state = useAppStore.getState()
    expect(state.activeThreadId).toBe(id)
    expect(state.threads.some((t) => t.id === id)).toBe(true)
  })

  it('删除线程后从列表移除', () => {
    const id = useAppStore.getState().activeThreadId
    useAppStore.getState().deleteThread(id)
    const state = useAppStore.getState()
    expect(state.threads.some((t) => t.id === id)).toBe(false)
  })

  it('固定线程标记 pinned', () => {
    /* 找一个非置顶的线程，避免 seed 里默认置顶的那个干扰 */
    const target = useAppStore.getState().threads.find((t) => !t.pinned)
    if (!target) throw new Error('没有非置顶线程')
    useAppStore.getState().togglePinThread(target.id)
    const thread = useAppStore.getState().threads.find((t) => t.id === target.id)
    expect(thread?.pinned).toBe(true)
  })

  it('归档线程标记 archived', () => {
    const target = useAppStore.getState().threads.find((t) => !t.archived)
    if (!target) throw new Error('没有未归档线程')
    useAppStore.getState().toggleArchiveThread(target.id)
    const thread = useAppStore.getState().threads.find((t) => t.id === target.id)
    expect(thread?.archived).toBe(true)
  })

  it('加标签去重', () => {
    const id = useAppStore.getState().activeThreadId
    useAppStore.getState().addThreadTag(id, 'bug')
    useAppStore.getState().addThreadTag(id, 'bug')
    const thread = useAppStore.getState().threads.find((t) => t.id === id)
    /* 不断言整个数组 —— 种子数据里本来就带了标签，断言会随种子变 */
    expect(thread?.tags.filter((tag) => tag === 'bug')).toEqual(['bug'])
    const tags = thread?.tags ?? []
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('加消息后线程消息数增加', () => {
    const id = useAppStore.getState().activeThreadId
    useAppStore.getState().addMessage(id, {
      id: 'm-test',
      threadId: id,
      role: 'user',
      content: 'hi',
      kind: 'text',
      status: 'sent',
      timestamp: Date.now(),
    })
    const thread = useAppStore.getState().threads.find((t) => t.id === id)
    expect(thread?.messages.some((m) => m.id === 'm-test')).toBe(true)
  })
})
