import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runElectronTurn } from '../turns'
import { loadSession } from '@/lib/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import type { Message, Thread } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   切对话稳定性：**A→B→A 切来切去，永远不许自己跑起来**

   用户报的 bug：AI 回复刚生成完，切走再切回来，它又自己输出了一轮。
   真机排查后触发点在「切提问版本」（见 switchNoRegen.test.ts）——
   但「切对话」这条路径也必须有护栏钉住：它现在全程安静，
   以后谁在 setActiveThread / 侧栏点击里加了「自动继续」，这里会第一个红。

   对应用户需求的 a–e 场景：
     · A→B→A：不重新生成
     · 快速多切 A→B→A→B：一次都不跑
     · 生成中切走再切回：流式状态原样（sendingThreads 不动、也不补一轮）
     · paused 的对话切回来：仍是 paused，不自动继续
     · failed 的对话切回来：仍是 failed，不自动重试
     · A→B→C→A→B 三个对话：状态各归各的
   ══════════════════════════════════════════════════════════════ */

vi.mock('../turns', () => ({ runElectronTurn: vi.fn(async () => {}) }))
vi.mock('@/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend')>()),
  useRealBackend: true,
  loadSession: vi.fn(async () => null),
  updateSessionMeta: vi.fn(async () => {}),
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

const thread = (id: string, messages: Message[], over: Partial<Thread> = {}): Thread => ({
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
  ...over,
})

function seed(threads: Thread[], activeId = 't1'): void {
  useAppStore.setState({ threads, activeThreadId: activeId, projects: [] } as never)
}

const calls = () => vi.mocked(runElectronTurn).mock.calls

/** 有版本的对话：切对话用例里当「A」用（形状真实，内容不参与断言） */
function twoVersionThread(): Thread {
  const records: StoredMessage[] = [
    { role: 'assistant', key: 'a0', content: '答第一版', answersVersion: 0, ts: 200 },
    { role: 'assistant', key: 'a1', content: '答第二版', answersVersion: 1, ts: 200 },
  ]
  return thread('t1', [
    msg({
      id: 'u1',
      role: 'user',
      content: '第二版',
      versions: ['第一版', '第二版'],
      versionIndex: 1,
      timestamp: 100,
    }),
    msg({
      id: 'a1',
      content: '答第二版',
      answersKey: 'u1',
      answersVersion: 1,
      timestamp: 200,
      answerRecords: records,
      answerIndex: 1,
    }),
  ])
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.mocked(runElectronTurn).mockClear()
  vi.mocked(loadSession).mockReset().mockResolvedValue(null)
  useThreadStore.setState({ sendingThreads: [] })
  useUIStore.setState({ toasts: [] })
  seed([twoVersionThread()])
})

describe('切对话', () => {
  it('★ A → B → A：切回来不许重新生成', async () => {
    seed([twoVersionThread(), thread('t2', [])])
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
    expect(useAppStore.getState().threads.find((t) => t.id === 't1')!.messages.length).toBe(2)
  })

  it('★ 快速多切 A→B→A→B：一次都不许跑', async () => {
    seed([twoVersionThread(), thread('t2', [])])
    for (const id of ['t2', 't1', 't2', 't1']) useAppStore.getState().setActiveThread(id)
    await flush()
    expect(calls().length).toBe(0)
  })

  it('★ 生成中切走再切回：原来的流还在跑（sendingThreads 不动、也不补一轮）', async () => {
    useThreadStore.setState({ sendingThreads: ['t1'] })
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
    expect(useThreadStore.getState().sendingThreads).toEqual(['t1'])
  })

  it('★ 暂停中的对话（phase=paused）切走再切回：仍是 paused，不自动继续', async () => {
    seed([
      thread('t1', [msg({ id: 'u1', role: 'user', content: '活干一半', timestamp: 100 })], {
        phase: 'paused',
        status: 'paused',
      }),
      thread('t2', []),
    ])
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
    const t1 = useAppStore.getState().threads.find((t) => t.id === 't1')!
    expect(t1.phase).toBe('paused')
    expect(t1.status).toBe('paused')
  })

  it('★ 出过错的对话（phase=failed）切走再切回：仍是 failed，不自动重试', async () => {
    seed([
      thread('t1', [msg({ id: 'u1', role: 'user', content: '发出去失败了', timestamp: 100 })], {
        phase: 'failed',
        status: 'error',
      }),
      thread('t2', []),
    ])
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
    const t1 = useAppStore.getState().threads.find((t) => t.id === 't1')!
    expect(t1.phase).toBe('failed')
    expect(t1.status).toBe('error')
  })

  it('★ A→B→C→A→B 三个对话连着切：状态各归各的，一次都不跑', async () => {
    seed([
      thread('t1', [msg({ id: 'u1', role: 'user', content: 'A 完事', timestamp: 100 })]),
      thread('t2', [], { phase: 'paused', status: 'paused' }),
      thread('t3', [], { phase: 'failed', status: 'error' }),
    ])
    for (const id of ['t2', 't3', 't1', 't2']) useAppStore.getState().setActiveThread(id)
    await flush()
    expect(calls().length).toBe(0)
    const by = (id: string) => useAppStore.getState().threads.find((t) => t.id === id)!
    expect(by('t1').phase).toBeUndefined()
    expect(by('t2').phase).toBe('paused')
    expect(by('t3').phase).toBe('failed')
    expect(by('t1').messages.length).toBe(1)
  })
})
