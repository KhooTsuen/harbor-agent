import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runElectronTurn } from '../turns'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   接线：「编辑 / 重新生成 / 切到没回答过的那一版」时，**原来那条回答**要交给
   这一轮带走。

   为什么单独测这个：这三条路都会先 `removeMessagesAfter` 把旧回答从消息列表里
   去掉，`runElectronTurn` 再去「提问后面找已有回答」就找不到了 —— 旧回答只剩
   磁盘上有，要重开会话才切得回去。

   ★ 真机上就是这么发现的：编辑完那条消息，回答下面的 ‹ n / N › **消失了**。
   单测照不到（两条路各自看都对，是**接线**错了）—— 所以这里 mock 掉 turns，
   直接断言参数。
   ══════════════════════════════════════════════════════════════ */

vi.mock('../turns', () => ({ runElectronTurn: vi.fn(async () => {}) }))
/* 只把「是真后端模式」这一个开关翻过来；整块替掉会把别的导出弄没（踩过） */
vi.mock('@/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend')>()),
  useRealBackend: true,
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

const calls = () => vi.mocked(runElectronTurn).mock.calls
const seedArg = () => calls().at(-1)?.[4] ?? []

beforeEach(() => {
  vi.mocked(runElectronTurn).mockClear()
  seed([])
})

describe('编辑一条消息', () => {
  it('★ 原来那条回答跟着这一轮走（不然 ‹ n / N › 会消失、要重开会话才切得回去）', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '原问题' }),
      msg({ id: 'a1', content: '原来那条回答', answersKey: 'u1', answersVersion: 0 }),
    ])
    useThreadStore.getState().editAndRerun('t1', 'u1', '改过的问题')
    expect(calls().length).toBe(1)
    expect(seedArg().map((r) => r.content)).toEqual(['原来那条回答'])
  })

  it('★ 而且标上「它属于改之前那一版」（不然切回上一版找不到它，又跑一轮）', () => {
    seed([
      msg({
        id: 'u1',
        role: 'user',
        content: '第二版',
        versions: ['第一版', '第二版'],
        versionIndex: 1,
      }),
      msg({ id: 'a1', content: '答第二版' }),
    ])
    useThreadStore.getState().editAndRerun('t1', 'u1', '第三版')
    expect(seedArg()[0]?.answersVersion).toBe(1)
  })
})

describe('重新生成', () => {
  it('★ 旧回答也交给新一轮（重新生成不该把上一版弄丢）', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '一个问题' }),
      msg({ id: 'a1', content: '第一次的回答', answersKey: 'u1', answersVersion: 0 }),
    ])
    useThreadStore.getState().regenerateMessage('a1')
    expect(calls().length).toBe(1)
    expect(seedArg().map((r) => r.content)).toEqual(['第一次的回答'])
  })
})

describe('切到没回答过的那一版', () => {
  it('★ 真跑那一版时也要把旧回答带上（它是另一版的，仍要能切回去）', () => {
    seed([
      msg({
        id: 'u1',
        role: 'user',
        content: '第二版',
        versions: ['第一版', '第二版'],
        versionIndex: 1,
      }),
      msg({
        id: 'a1',
        content: '答第二版',
        answersKey: 'u1',
        answersVersion: 1,
        answerRecords: [{ role: 'assistant', key: 'a1', content: '答第二版', answersVersion: 1 }],
      }),
    ])
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    expect(calls().length).toBe(1)
    expect(seedArg().map((r) => r.content)).toEqual(['答第二版'])
  })

  it('这一版已经回答过 → 一个模型请求都不发（换上那条就行）', () => {
    seed([
      msg({
        id: 'u1',
        role: 'user',
        content: '第二版',
        versions: ['第一版', '第二版'],
        versionIndex: 1,
      }),
      msg({
        id: 'a1',
        content: '答第二版',
        answerRecords: [
          { role: 'assistant', key: 'a0', content: '答第一版', answersVersion: 0 },
          { role: 'assistant', key: 'a1', content: '答第二版', answersVersion: 1 },
        ],
      }),
    ])
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    expect(calls().length).toBe(0)
    expect(useAppStore.getState().threads[0]!.messages[1]!.content).toBe('答第一版')
  })
})
