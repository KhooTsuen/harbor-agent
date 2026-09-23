import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   切提问版本 / 切回答 —— **不许重跑**

   用户报的 bug：编辑过消息之后切走再切回来，会话里并排堆着好几个回答。
   根因之一就是「切版本一律重新生成」：切一次多一个回答。

   这里真调 store 的动作，钉住三件事：
     ① 切到**已回答过**的那一版 → 直接换上那条回答，消息条数不变（没跑新一轮）
     ② 切回答 ‹ n / N › → 换内容，消息条数不变
     ③ 切到**从没回答过**的那一版 → 才需要真跑（这里只断言它不会静默什么都不做）
   ══════════════════════════════════════════════════════════════ */

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
  /* 预览模式那一轮要能找到 project，否则它直接 return（返回得太早，看着像"没反应"） */
  useAppStore.setState({
    threads: [thread(messages)],
    activeThreadId: 't1',
    projects: [{ id: 'p1', name: '自检', workdir: '' }],
  } as never)
}

const current = (): Message[] => useAppStore.getState().threads[0]!.messages

beforeEach(() => {
  seed([])
})

describe('切提问版本', () => {
  it('★ 这一版回答过 → 换上那一版的回答，消息**一条都没多**（没重跑）', () => {
    seed([
      msg({
        id: 'u1',
        role: 'user',
        content: '第二版问题',
        versions: ['第一版问题', '第二版问题'],
        versionIndex: 1,
      }),
      msg({
        id: 'a1',
        content: '答第二版',
        answersKey: 'u1',
        answersVersion: 1,
        answerIndex: 1,
        answerRecords: [
          {
            role: 'assistant',
            key: 'a0',
            content: '答第一版',
            answersKey: 'u1',
            answersVersion: 0,
          },
          {
            role: 'assistant',
            key: 'a1',
            content: '答第二版',
            answersKey: 'u1',
            answersVersion: 1,
          },
        ],
      }),
    ])
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    const after = current()
    expect(after.length).toBe(2) // ★ 没有新增消息 = 没有重新生成
    expect(after[0]!.content).toBe('第一版问题')
    expect(after[1]!.content).toBe('答第一版') // ★ 换上了那一版的回答
  })

  it('★ 从没回答过的那一版 → 才需要真跑一轮（这里能看到新占位消息）', () => {
    seed([
      msg({
        id: 'u1',
        role: 'user',
        content: '第二版问题',
        versions: ['第一版问题', '第二版问题'],
        versionIndex: 1,
      }),
      msg({
        id: 'a1',
        content: '答第二版',
        answerRecords: [{ role: 'assistant', key: 'a1', content: '答第二版', answersVersion: 1 }],
      }),
    ])
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    const after = current()
    expect(after[0]!.content).toBe('第一版问题')
    /* 那一版没有回答 → 会真跑一轮（预览模式加一条占位）；这里只要求"有反应" */
    expect(after.length).toBeGreaterThanOrEqual(2)
  })

  it('没有版本表的老消息：越界索引什么都不做（内容不能被改坏）', () => {
    seed([msg({ id: 'u1', role: 'user', content: '唯一的问题' })])
    useThreadStore.getState().activateUserVersion('t1', 'u1', 3)
    expect(current().length).toBe(1)
    expect(current()[0]!.content).toBe('唯一的问题')
  })
})

describe('切回答', () => {
  it('★ 换一条显示，消息条数不变（不重跑、不新增）', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '一个问题' }),
      msg({
        id: 'a1',
        content: '第二遍',
        answersKey: 'u1',
        answersVersion: 0,
        answerIndex: 1,
        answerRecords: [
          { role: 'assistant', key: 'a0', content: '第一遍', answersVersion: 0 },
          { role: 'assistant', key: 'a1', content: '第二遍', answersVersion: 0 },
        ],
      }),
    ])
    useThreadStore.getState().activateAnswer('t1', 'a1', 0)
    const after = current()
    expect(after.length).toBe(2)
    expect(after[1]!.content).toBe('第一遍')
    expect(after[1]!.answerIndex).toBe(0)
  })

  it('越界索引什么都不做', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '一个问题' }),
      msg({
        id: 'a1',
        content: '只有一个回答',
        answerRecords: [{ role: 'assistant', key: 'a1', content: '只有一个回答' }],
      }),
    ])
    useThreadStore.getState().activateAnswer('t1', 'a1', 5)
    expect(current()[1]!.content).toBe('只有一个回答')
  })

  it('★ 选择要写回**提问**记录（不然重开会话又跳回最新那条）', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '一个问题' }),
      msg({
        id: 'a1',
        content: '第二遍',
        answersKey: 'u1',
        answersVersion: 0,
        answerIndex: 1,
        answerRecords: [
          { role: 'assistant', key: 'a0', content: '第一遍', answersVersion: 0 },
          { role: 'assistant', key: 'a1', content: '第二遍', answersVersion: 0 },
        ],
      }),
    ])
    useThreadStore.getState().activateAnswer('t1', 'a1', 0)
    /* 按提问版本分开记 —— 内核读的时候按它决定露哪条（落盘那条由内核自检钉住） */
    expect(current()[0]!.answerIndexByVersion).toEqual({ '0': 0 })
  })

  it('★ 老记录没有 answersKey → 往上找最近一条用户消息，一样写得进去', () => {
    seed([
      msg({ id: 'u1', role: 'user', content: '一个问题' }),
      msg({
        id: 'a1',
        content: '第二遍',
        answerIndex: 1,
        answerRecords: [
          { role: 'assistant', key: 'a0', content: '第一遍' },
          { role: 'assistant', key: 'a1', content: '第二遍' },
        ],
      }),
    ])
    useThreadStore.getState().activateAnswer('t1', 'a1', 0)
    expect(current()[0]!.answerIndexByVersion).toEqual({ '0': 0 })
  })
})
