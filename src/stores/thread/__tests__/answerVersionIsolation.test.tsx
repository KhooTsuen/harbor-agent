import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runElectronTurn } from '../turns'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { allAnswers, answersOfVersion } from '@/lib/answers'
import { AnswerVersions } from '@/components/chat/message/AnswerVersions'
import type { Message, Thread } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   回答版本的隔离（用户报的 bug）

   场景：提问先答了 A（重生成 5 次 → 6 条，全属第 0 版），编辑成 B 后再重生成
   2 次 —— B 的切换器应显示 1 / 3，而不是把 A 的 6 条也数进来（1 / 8、1 / 9）。
   根因：旧回答交给新一轮（seedAnswers）前被无条件重贴版本标签。

   覆盖面：验收 a / b / c / d / e + f / g 回归（既有套件）。
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

const calls = () => vi.mocked(runElectronTurn).mock.calls
const seedArg = () =>
  (calls().at(-1)?.[4] as { seedAnswers?: StoredMessage[] } | undefined)?.seedAnswers ?? []

const aRec = (n: number): StoredMessage => ({
  role: 'assistant',
  key: `dka${n}`,
  content: `A 的第 ${n} 条回答`,
  answersVersion: 0,
  ts: n,
})
const sixOfA = [1, 2, 3, 4, 5, 6].map(aRec)
/** 第 1 版（B）的回答记录 —— 到第 n 条为止 */
const bRec = (n: number): StoredMessage => ({
  role: 'assistant',
  key: `dkb${n}`,
  content: `B 的第 ${n} 条回答`,
  answersVersion: 1,
  ts: 100 + n,
})
/** 用户提问：两版文字（A→B），当前停在 B */
const q1 = (): Message =>
  msg({
    id: 'q1',
    diskKey: 'qk1',
    role: 'user',
    content: 'B 内容',
    versions: ['A 内容', 'B 内容'],
    versionIndex: 1,
    timestamp: 100,
  })
/** 编辑到 B 之后生成的那条回答（内存里的样子，与 turns.ts 占位同形状） */
const aB1 = (): Message =>
  msg({
    id: 'aB1',
    diskKey: 'dkb1',
    content: 'B 的第 1 条回答',
    answersKey: 'q1',
    answersVersion: 1,
    answerIndex: sixOfA.length,
    answerRecords: sixOfA,
    timestamp: 200,
  })

/** 模拟 turns 收尾后的内存状态：新回答带走种子，自己标当前版 */
function afterGeneration(id: string, version: number, records: StoredMessage[]): Message {
  return msg({
    id,
    content: `${version} 版回答（${id}）`,
    answersKey: 'q1',
    answersVersion: version,
    answerIndex: records.length,
    answerRecords: records,
    timestamp: 300,
  })
}

const countOfA = (seeds: StoredMessage[]): number =>
  seeds.filter((r) => (r.answersVersion ?? 0) === 0).length
const countOfB = (seeds: StoredMessage[]): number =>
  seeds.filter((r) => r.answersVersion === 1).length

beforeEach(() => {
  vi.mocked(runElectronTurn).mockClear()
  useThreadStore.setState({ sendingThreads: [] })
  useUIStore.setState({ toasts: [] })
  seed([])
})

describe('重新生成时的版本隔离（验收 a / d）', () => {
  it('a · B 下重新生成：A 的 6 条仍标第 0 版，不会被改标成第 1 版', () => {
    seed([q1(), aB1()])
    useThreadStore.getState().regenerateMessage('aB1')
    const seeds = seedArg()
    /* 交给下一轮的种子：6 条 A（第 0 版）+ 1 条 B（第 1 版），一个都不能串 */
    expect(countOfA(seeds)).toBe(6)
    expect(countOfB(seeds)).toBe(1)
  })

  it('a · 连着重生成两次：B 数出来 = 3（不是 8、不是 9）', () => {
    seed([q1(), aB1()])
    useThreadStore.getState().regenerateMessage('aB1')
    const s1 = seedArg()

    /* 模拟收尾：B 的第 2 条带走种子、自己标第 1 版 —— 与 turns.ts 一致 */
    seed([q1(), afterGeneration('aB2', 1, s1)])
    useThreadStore.getState().regenerateMessage('aB2')
    const s2 = seedArg()

    /* 种子里 A 仍 6 条、B 已有 2 条 */
    expect(countOfA(s2)).toBe(6)
    expect(countOfB(s2)).toBe(2)

    /* 界面 N 的口径（AnswerVersions 用的就是这两句）：B = 3 */
    const finalMsg = afterGeneration('aB3', 1, s2)
    expect(answersOfVersion(allAnswers(finalMsg), 1)).toHaveLength(3)
    /* 切回 A（第 0 版）时也稳稳 6 条 */
    expect(answersOfVersion(allAnswers(finalMsg), 0)).toHaveLength(6)
  })

  it('d · 再编辑成 C：A / B 的标签都不动，C 从 1 开始数', () => {
    const aB3 = msg({
      id: 'aB3',
      content: 'B 的第 3 条回答',
      answersKey: 'q1',
      answersVersion: 1,
      answerIndex: 8,
      answerRecords: [...sixOfA, bRec(1), bRec(2)],
      timestamp: 300,
    })
    seed([q1(), aB3])
    useThreadStore.getState().editAndRerun('t1', 'q1', 'C 内容')
    const seeds = seedArg()
    expect(countOfA(seeds)).toBe(6)
    expect(countOfB(seeds)).toBe(3)

    /* C（第 2 版）是新的子树：只有它自己那条 */
    const finalMsg = afterGeneration('aC1', 2, seeds)
    expect(answersOfVersion(allAnswers(finalMsg), 2)).toHaveLength(1)
    expect(answersOfVersion(allAnswers(finalMsg), 0)).toHaveLength(6)
    expect(answersOfVersion(allAnswers(finalMsg), 1)).toHaveLength(3)
  })
})

describe('切换只在本版兄弟之间（验收 b / c）', () => {
  it('b · B 下切换回答：只在 B 的 3 条里换，看不到 A 的内容', () => {
    const aB3 = msg({
      id: 'aB3',
      content: 'B 的第 3 条回答',
      answersKey: 'q1',
      answersVersion: 1,
      answerIndex: 2,
      answerRecords: [...sixOfA, bRec(1), bRec(2)],
      timestamp: 300,
    })
    seed([q1(), aB3])
    useThreadStore.getState().activateAnswer('t1', 'aB3', 0)
    const shown = useAppStore.getState().threads[0]!.messages[1]!
    expect(shown.content).toBe('B 的第 1 条回答')
    expect(shown.content).not.toContain('A 的')
    /* 切回去也是 B 的第三条 */
    useThreadStore.getState().activateAnswer('t1', 'aB3', 2)
    expect(useAppStore.getState().threads[0]!.messages[1]!.content).toBe('B 的第 3 条回答')
  })

  it('c · 同一条记录表里 A 的可切条数 = 6，B = 3（口径按 answersVersion 分）', () => {
    const aB3 = msg({
      id: 'aB3',
      content: 'B 的第 3 条回答',
      answersKey: 'q1',
      answersVersion: 1,
      answerIndex: 8,
      answerRecords: [...sixOfA, bRec(1), bRec(2)],
      timestamp: 300,
    })
    expect(answersOfVersion(allAnswers(aB3), 0)).toHaveLength(6)
    expect(answersOfVersion(allAnswers(aB3), 1)).toHaveLength(3)
  })
})

describe('重开后的形状（验收 e）', () => {
  it('e · 重读换新 uid 后：「自己」按磁盘 key 去重，不会被重复数一遍', () => {
    const message = msg({
      /* 内核分组给的形状：消息 id 是新 uid，磁盘 key 原样带着，自己也在台账里 */
      id: 'msg_fresh_uid',
      diskKey: 'dkb3',
      content: 'B 的第 3 条回答',
      answerRecords: [
        ...sixOfA,
        bRec(1),
        bRec(2),
        { role: 'assistant', key: 'dkb3', content: 'B 的第 3 条回答', answersVersion: 1, ts: 3 },
      ],
      answersVersion: 1,
      answerIndex: 2,
    })
    expect(answersOfVersion(allAnswers(message), 1)).toHaveLength(3)
    expect(answersOfVersion(allAnswers(message), 0)).toHaveLength(6)
  })
})

describe('切换器显示（验收 a：1/3 而不是 1/8）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('B（第 1 版）：显示 1 / 3，A 的 6 条不数进来', () => {
    const records: StoredMessage[] = [...sixOfA, bRec(1), bRec(2)]
    act(() =>
      root.render(
        <AnswerVersions
          message={msg({
            id: 'aB3',
            content: 'B 的第 3 条回答',
            answerRecords: records,
            answersVersion: 1,
            answerIndex: 0,
          })}
        />,
      ),
    )
    expect(container.textContent).toContain('1 / 3')
    expect(container.textContent).not.toContain('1 / 9')
  })

  it('A（第 0 版）：显示 1 / 6，不受 B 影响', () => {
    const records: StoredMessage[] = [...sixOfA, bRec(1), bRec(2)]
    act(() =>
      root.render(
        <AnswerVersions
          message={msg({
            /* A 视图下展示的是 A 的第 6 条 —— 它自己就在台账里（内核走的就是这个形状） */
            id: 'dka6',
            content: 'A 的第 6 条回答',
            answerRecords: records,
            answersVersion: 0,
            answerIndex: 0,
          })}
        />,
      ),
    )
    expect(container.textContent).toContain('1 / 6')
  })
})
