import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runElectronTurn } from '../turns'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { taskList, taskRecovery } from '@/lib/safetyApi'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   任务隔离（渲染层侧）—— 验收 a/b/d/e/g

   用户报的 bug：A 的任务中断后，切到 / 新建 B —— B 会「继续执行 A 的任务」。
   真实泄漏点在主进程提示层（`task-context.cjs` 的 buildTaskState 兜底注入了
   其他会话的任务台账，内核组 82-task-isolation 钉住了它）。

   这个文件钉的是**渲染层这一侧**：切对话 / 新建对话 / 刷清单都只碰视图，
   任何「跑一轮」都必须由用户显式动作触发：

     a. 新建对话是空白的，不发任何请求
     b. A→B→A 切回：不生成、不恢复，消息原样      （g 回归：同一条底线）
     c. 快速多切：一次都不跑
     d. 只有显式 resumeTask 才真的发（带上 resumeTaskId，走普通发送链路）
     e. 启动清单（refresh）是纯读：不触发任何生成 / 恢复
   ══════════════════════════════════════════════════════════════ */

vi.mock('../turns', () => ({
  runElectronTurn: vi.fn(async () => {}),
  stopActiveRequest: vi.fn(),
}))
vi.mock('@/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend')>()),
  useRealBackend: true,
  loadSession: vi.fn(async () => null),
  appendMessage: vi.fn(async () => {}),
  updateSessionMeta: vi.fn(async () => {}),
}))
vi.mock('@/lib/safetyApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safetyApi')>()),
  taskList: vi.fn(async () => []),
  taskRecovery: vi.fn(async () => []),
  changesetList: vi.fn(async () => []),
  changesetDiff: vi.fn(async () => null),
}))

const msg = (over: Partial<Message>): Message => ({
  id: 'm',
  threadId: 't1',
  role: 'assistant',
  content: '',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

const thread = (id: string, messages: Message[]): Thread => ({
  id,
  projectId: 'p1',
  title: '自检对话',
  messages,
  status: 'idle',
  mode: 'pair',
  model: 'probe',
  reasoning: 'high',
  pinned: false,
  archived: false,
  tags: [],
  exportedAt: 0,
  createdAt: 1,
  updatedAt: 1,
})

/** A 有历史；B 也有自己的历史（模拟两条真实对话） */
const seedTwo = (): void => {
  useAppStore.setState({
    threads: [
      thread('t1', [
        msg({ id: 'a1', threadId: 't1', role: 'user', content: 'A 的问题', timestamp: 100 }),
        msg({ id: 'a2', threadId: 't1', content: 'A 的回答', timestamp: 200 }),
      ]),
      thread('t2', [
        msg({ id: 'b1', threadId: 't2', role: 'user', content: 'B 的问题', timestamp: 100 }),
      ]),
    ],
    activeThreadId: 't1',
    projects: [],
  } as never)
}

const calls = () => vi.mocked(runElectronTurn).mock.calls
const idsOf = (id: string): string[] =>
  useAppStore
    .getState()
    .threads.find((t) => t.id === id)!
    .messages.map((m) => m.id)

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.mocked(runElectronTurn).mockClear()
  vi.mocked(taskList).mockClear()
  vi.mocked(taskRecovery).mockClear()
  useAppStore.getState().resetAll()
  useThreadStore.setState({ sendingThreads: [], input: '' })
  seedTwo()
})

describe('任务隔离 / 切对话与新建对话都不跑活', () => {
  it('a · 新建对话是空白的：不发任何请求（不扫描、不继承）', async () => {
    const id = useAppStore.getState().createThread()
    await flush()
    const created = useAppStore.getState().threads.find((t) => t.id === id)!
    expect(created.messages).toHaveLength(0)
    expect(calls().length).toBe(0)
  })

  it('b · A→B→A：不生成、不恢复，两边消息原样', async () => {
    useAppStore.getState().setActiveThread('t2')
    await flush()
    expect(idsOf('t2')).toEqual(['b1'])

    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(idsOf('t1')).toEqual(['a1', 'a2'])
    expect(idsOf('t2')).toEqual(['b1'])
    expect(calls().length).toBe(0)
  })

  it('c · 快速多切 A→B→A→B：一次都不跑', async () => {
    for (const id of ['t2', 't1', 't2', 't1']) useAppStore.getState().setActiveThread(id)
    await flush()
    expect(calls().length).toBe(0)
  })

  it('g · 回归：切对话不重新生成（beta.5 修好的那条底线还在）', async () => {
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
  })
})

describe('任务隔离 / 恢复必须是显式动作', () => {
  it('d · resumeTask 是唯一入口：显式调用才发，而且带上 resumeTaskId', async () => {
    expect(calls().length).toBe(0)

    useThreadStore.getState().resumeTask('task-A1')
    await flush()

    expect(calls().length).toBe(1)
    const call = calls()[0]!
    expect(call[0]).toBe('t1') // 发在**当前活跃**对话里（任务中心会先切到它自己的会话）
    expect(String(call[1])).toContain('接着做')
    expect(call[3]).toBe('task-A1') // 第 4 参 = resumeTaskId（主进程据此复用原任务）
  })

  it('e · 启动清单（refresh）是纯读：碰了读取 API，但没有生成 / 恢复', async () => {
    await useTaskStore.getState().refresh()
    expect(vi.mocked(taskList).mock.calls.length).toBe(1)
    expect(vi.mocked(taskRecovery).mock.calls.length).toBe(1)
    expect(calls().length).toBe(0)
  })
})
