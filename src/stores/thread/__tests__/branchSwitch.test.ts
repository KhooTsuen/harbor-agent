import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendMessage } from '@/lib/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { getForkPoints } from '@/lib/branchPath'
import { runElectronTurn } from '../turns'
import { switchBranch } from '../branchSwitch'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分支切换的接线（验收 f）

   两条路分别走既有动作，这里钉住：
     · 提问版 → activateUserVersion：写盘（磁盘 key + versionIndex）、不跑生成
     · 回答版 → activateAnswer：换显示、选择写回提问记录（answerIndexByVersion）
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

const thread = (messages: Message[]): Thread => ({
  id: 't1',
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

function seed(messages: Message[]): void {
  useAppStore.setState({ threads: [thread(messages)], activeThreadId: 't1', projects: [] } as never)
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}

const writes = () =>
  vi.mocked(appendMessage).mock.calls.map((c) => c[1] as unknown as Record<string, unknown>)

const forkMessages = (): Message[] => [
  msg({
    id: 'q1',
    diskKey: 'qk1',
    role: 'user',
    content: 'B 内容',
    versions: ['A 内容', 'B 内容'],
    versionIndex: 1,
    timestamp: 1,
  }),
  msg({
    id: 'a1',
    content: 'B 的第二条回答',
    answersKey: 'q1',
    answersVersion: 1,
    answerIndex: 1,
    answerRecords: [
      { role: 'assistant', key: 'r1', content: 'B 的第一条回答', answersVersion: 1, ts: 1 },
    ],
    timestamp: 2,
  }),
]

beforeEach(() => {
  vi.mocked(appendMessage).mockClear()
  vi.mocked(runElectronTurn).mockClear()
  seed([])
})

describe('switchBranch', () => {
  it('f · 提问版：写盘（磁盘 key + versionIndex）且不跑生成', async () => {
    seed(forkMessages())
    const forks = getForkPoints(useAppStore.getState().threads[0]!.messages)
    expect(forks[0]?.kind).toBe('question')

    switchBranch(forks[0]!, 0)
    await flush()

    expect(vi.mocked(runElectronTurn)).not.toHaveBeenCalled()
    expect(
      writes().some((r) => r.key === 'qk1' && r.versionIndex === 0 && Array.isArray(r.versions)),
    ).toBe(true)
  })

  it('f · 回答版：换显示 + 选择写回提问记录（不重跑）', () => {
    seed(forkMessages())
    const forks = getForkPoints(useAppStore.getState().threads[0]!.messages)
    expect(forks[1]?.kind).toBe('answer')

    switchBranch(forks[1]!, 0)

    const after = useAppStore.getState().threads[0]!.messages
    expect(after[1]?.content).toBe('B 的第一条回答')
    expect(after[1]?.answerIndex).toBe(0)
    expect(
      writes().some((r) => (r.answerIndexByVersion as Record<string, number>)?.['1'] === 0),
    ).toBe(true)
    expect(vi.mocked(runElectronTurn)).not.toHaveBeenCalled()
  })

  it('分发按 kind：question → activateUserVersion，answer → activateAnswer', () => {
    seed(forkMessages())
    const forks = getForkPoints(useAppStore.getState().threads[0]!.messages)

    const spyUser = vi.spyOn(useThreadStore.getState(), 'activateUserVersion')
    switchBranch(forks[0]!, 1)
    expect(spyUser).toHaveBeenCalledWith('t1', 'q1', 1)

    const spyAnswer = vi.spyOn(useThreadStore.getState(), 'activateAnswer')
    switchBranch(forks[1]!, 0)
    expect(spyAnswer).toHaveBeenCalledWith('t1', 'a1', 0)
  })
})
