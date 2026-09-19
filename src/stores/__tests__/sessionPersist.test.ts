import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   会话落盘 / 读回（真机跑真实模型时挖出来的两类 bug）

   ① 助手回复从来没写进会话文件 —— 磁盘上永远只有 meta + user
   ② 重启后当前对话是空的（启动只设 activeThreadId，不读消息）；
      而 setActiveThread → openFromDisk 又是异步的，读回来直接覆盖，
      会把「点继续」时刚加进去的消息抹掉

   这里锁住修复，防止「看着像性能优化」改回去。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
  sent: null as { requestId: string } | null,
  appended: [] as Array<{ id: string; message: Record<string, unknown> }>,
  pendingLoad: null as null | ((value: { messages: unknown[] } | null) => void),
}))

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
    abortChat: async () => {},
    confirmChat: async () => {},
    appendMessage: async (id: string, message: Record<string, unknown>) => {
      h.appended.push({ id, message })
      return { ok: true }
    },
    /* 读盘由用例自己决定什么时候返回 —— 竞态就是这么造出来的 */
    loadSession: async (id: string) =>
      new Promise((resolve) => {
        h.pendingLoad = (value) => resolve(value && { ...value, id })
      }),
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { runElectronTurn } from '@/stores/thread/turns'
import { useThreadStore } from '../useThreadStore'

function emitFromBackend(event: Record<string, unknown>): void {
  const requestId = h.sent?.requestId ?? ''
  for (const listener of [...h.listeners]) listener({ requestId, ...event })
}

function userMessage(threadId: string, content: string) {
  return {
    id: `msg_${content}`,
    threadId,
    role: 'user' as const,
    content,
    kind: 'text' as const,
    status: 'sent' as const,
    timestamp: Date.now(),
  }
}

describe('会话落盘 / 助手回复', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    h.listeners = []
    h.sent = null
    h.appended = []
    h.pendingLoad = null
  })

  it('★ done 之后助手回复会写进会话', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'content', text: '好的' })
    emitFromBackend({ type: 'done', content: '好的' })
    await pending

    const reply = h.appended.find((item) => item.message.role === 'assistant')
    expect(reply).toBeTruthy()
    expect(reply?.id).toBe(threadId)
    expect(reply?.message.content).toBe('好的')
  })

  it('aborted 也存（用户自己按停，半截也算结果）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'content', text: '半截' })
    emitFromBackend({ type: 'aborted' })
    await pending

    expect(h.appended.some((item) => item.message.role === 'assistant')).toBe(true)
  })

  it('error 不存 —— 报错不该当历史喂回模型', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'error', message: '炸了' })
    await pending

    expect(h.appended.some((item) => item.message.role === 'assistant')).toBe(false)
  })

  it('空回复不写空消息', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = runElectronTurn(threadId, 'hi', () => {})
    await Promise.resolve()
    await Promise.resolve()

    emitFromBackend({ type: 'done', content: '' })
    await pending

    expect(h.appended.some((item) => item.message.role === 'assistant')).toBe(false)
  })
})

describe('会话读回 / openFromDisk', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    h.pendingLoad = null
  })

  it('没人动过 → 磁盘消息读进来', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = useAppStore.getState().openFromDisk(threadId)
    h.pendingLoad?.({ messages: [{ role: 'user', content: '磁盘上的', ts: 1 }] })
    await pending

    const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
    expect(thread?.messages.map((m) => m.content)).toContain('磁盘上的')
  })

  it('★ 读盘期间新加的消息不能被覆盖（点「继续」就是这条）', async () => {
    const threadId = useAppStore.getState().activeThreadId
    const pending = useAppStore.getState().openFromDisk(threadId)

    /* await 期间用户发了消息（resumeTask：setActiveThread 紧接着 sendMessage） */
    const store = useAppStore.getState()
    store.addMessage(threadId, userMessage(threadId, '刚发的') as never)

    h.pendingLoad?.({ messages: [{ role: 'user', content: '磁盘上的旧消息', ts: 1 }] })
    await pending

    const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
    const contents = thread?.messages.map((m) => m.content) ?? []
    /* 磁盘内容一条都不该进来，刚发的那条必须还在（种子数据里有几条无所谓） */
    expect(contents).not.toContain('磁盘上的旧消息')
    expect(contents.at(-1)).toBe('刚发的')
  })
})

describe('会话读回 / 接线守卫', () => {
  const SRC = join(__dirname, '..', '..')

  it('★ 启动时会读当前对话的消息', () => {
    const src = readFileSync(join(SRC, 'hooks/useAppBootstrap.ts'), 'utf8')
    expect(src).toMatch(/openFromDisk\(activeId\)/)
  })

  it('★ 覆盖前要比内存里的数组还是不是原来那个', () => {
    const src = readFileSync(join(SRC, 'stores/useAppStore.ts'), 'utf8')
    expect(src).toMatch(/current\.messages !== before\?\.messages/)
  })

  it('★ 收尾时调用落盘，而且只在一处收尾', () => {
    const src = readFileSync(join(SRC, 'stores/thread/turns.ts'), 'utf8')
    expect(src).toMatch(/persistReply\(\)/)
    expect(src.match(/const finish = /g)?.length).toBe(1)
  })

  it('计划块约定在系统提示里（否则新对话永远不会给计划）', () => {
    const src = readFileSync(join(SRC, '..', 'electron/core/prompt-stack.cjs'), 'utf8')
    expect(src).toMatch(/第一行写任务名/)
  })
})

/* 让 vitest 认识这里用到的 store（避免 tree-shaking 掉） */
void useThreadStore
