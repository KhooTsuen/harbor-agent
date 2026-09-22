import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import type { Message, Thread } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   发消息时标上「接在哪条提问的哪一版后面」

   读会话时靠它筛：编辑中间那条消息之后，后面几轮（按旧内容写的）会被筛掉，
   **切回那一版它们再回来** —— 用户说的"树"那层，但不用给记录加分支 id。

   这一条必须真的落到磁盘记录上：只在内存里带没用（重开会话就丢了）。
   ══════════════════════════════════════════════════════════════ */

interface Written {
  id: string
  message: StoredMessage
}
const written: Written[] = []

const msg = (over: Partial<Message>): Message => ({
  id: 'm',
  threadId: 't1',
  role: 'user',
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

beforeEach(() => {
  written.length = 0
  useAppStore.setState({
    threads: [thread([msg({ id: 'u1', content: '第一句提问' })])],
    activeThreadId: 't1',
    projects: [{ id: 'p1', name: '自检', path: '' }],
    persistMessage: (id: string, message: StoredMessage) => {
      written.push({ id, message })
    },
  } as never)
  /* ★ 也要清 sendingThreads：上一条用例开了轮次，留着的话这条会被当成「排队」而不发 */
  useThreadStore.setState({ input: '第二句提问', sendingThreads: [], queuedMessages: {} })
})

describe('发消息时的锚点', () => {
  it('★ 记下「接在哪条提问的哪一版后面」', () => {
    useThreadStore.getState().sendMessage()
    const row = written.find((w) => w.message.role === 'user' && w.message.content === '第二句提问')
    expect(row).toBeDefined()
    expect(row?.message.parentKey).toBe('u1')
    expect(row?.message.parentVersion).toBe(0)
  })

  it('★ 第一条消息没有上一条提问 → 不带这两个字段（读的时候一律保留）', () => {
    useAppStore.setState({ threads: [thread([])], activeThreadId: 't1' } as never)
    useThreadStore.getState().sendMessage()
    const row = written.find((w) => w.message.role === 'user')
    expect(row?.message.parentKey).toBeUndefined()
    expect(row?.message.parentVersion).toBeUndefined()
  })

  it('★ 上一条提问改过版本时，锚点跟的是**当前**那一版', () => {
    useAppStore.setState({
      threads: [
        thread([
          msg({ id: 'u1', content: '第二版', versions: ['第一版', '第二版'], versionIndex: 1 }),
        ]),
      ],
      activeThreadId: 't1',
    } as never)
    useThreadStore.getState().sendMessage()
    const row = written.find((w) => w.message.role === 'user' && w.message.content === '第二句提问')
    expect(row?.message.parentVersion).toBe(1)
  })
})
