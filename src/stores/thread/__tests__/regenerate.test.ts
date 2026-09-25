import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stopActiveRequest, runElectronTurn } from '../turns'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { hasPendingRegen, drainPendingRegen } from '../regenQueue'
import type { Message, Thread } from '@/types'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   重新生成 / 重试 —— 验收 a–g（渲染层侧）

   复用「编辑」的分支机制：**不新增提问**，换的是同一次提问的又一个回答
   （旧回答保留在 answerRecords 里，界面 ‹ n / N › 切）。

   验收对照：
     a. 正常重新生成：复用同一通道重跑、旧回答交给这轮、提问不复制 —— 本文件
     b. 流式中重新生成：先中止（stopActiveRequest）→ 排队 → 收尾后自动开跑
     c（文件副作用隔离）/ d（预算不重置）/ f（台账两条记录）：主进程侧，见自检 81-regen
     e. 连续第 6 次：提示换个方向
     g. 切对话不许触发重新生成（刚修好的 bug 不许回归）
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

function seed(threads: Thread[], activeId = 't1'): void {
  useAppStore.setState({ threads, activeThreadId: activeId, projects: [] } as never)
}

const calls = () => vi.mocked(runElectronTurn).mock.calls
const optsArg = () =>
  calls().at(-1)?.[4] as
    | {
        seedAnswers?: StoredMessage[]
        reason?: string
        regeneratedFrom?: string
        regenerateIsLast?: boolean
      }
    | undefined

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.mocked(runElectronTurn).mockClear()
  vi.mocked(stopActiveRequest).mockClear()
  useThreadStore.setState({ sendingThreads: [] })
  useUIStore.setState({ toasts: [] })
  seed([])
})

describe('重新生成（验收 a / 复用编辑的分支机制）', () => {
  it('a · 复用同一通道重跑：旧回答留作历史版本、提问不被复制', () => {
    seed([
      thread('t1', [
        msg({ id: 'q-a', role: 'user', content: '帮我改一下 README', timestamp: 100 }),
        msg({
          id: 'ans-a',
          diskKey: 'dk-a',
          content: '第一版回答',
          answersKey: 'q-a',
          answersVersion: 0,
          timestamp: 200,
        }),
      ]),
    ])
    useThreadStore.getState().regenerateMessage('ans-a')

    expect(calls().length).toBe(1)
    const opts = optsArg()
    expect(opts?.reason).toBe('重新生成')
    /* 台账关联：被替代的是磁盘上的 dk-a（重读会换内存 id，所以用磁盘 key） */
    expect(opts?.regeneratedFrom).toBe('dk-a')
    expect(opts?.regenerateIsLast).toBe(true)
    /* 旧回答作为「这一版的历史回答」跟着走 —— 这就是「旧分支保留」（‹ n / N › 的数据） */
    expect((opts?.seedAnswers ?? []).map((r) => r.content)).toEqual(['第一版回答'])

    /* 提问没有被复制：用户消息仍然只有一条 */
    const msgs = useAppStore.getState().threads.find((t) => t.id === 't1')!.messages
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs.find((m) => m.role === 'user')!.content).toBe('帮我改一下 README')
  })

  it('被中止的回答：走「重试」语义（日志 reason 也是重试）', () => {
    seed([
      thread('t1', [
        msg({ id: 'q-r', role: 'user', content: '跑一下测试', timestamp: 100 }),
        msg({ id: 'ans-r', diskKey: 'dk-r', content: '半截', interrupted: true, timestamp: 200 }),
      ]),
    ])
    useThreadStore.getState().regenerateMessage('ans-r')
    expect(optsArg()?.reason).toBe('重试')
  })

  it('重做的不是最后一轮：不带台账关联（regenerateIsLast = false，宁可不连也不连错）', () => {
    seed([
      thread('t1', [
        msg({ id: 'q1', role: 'user', content: '第一问', timestamp: 100 }),
        msg({ id: 'ans1', content: '第一答', timestamp: 200 }),
        msg({ id: 'q2', role: 'user', content: '第二问', timestamp: 300 }),
        msg({ id: 'ans2', content: '第二答', timestamp: 400 }),
      ]),
    ])
    useThreadStore.getState().regenerateMessage('ans1')
    /* 未带关联：字段不落（false 会被省略）—— 「宁可不连也不连错」 */
    expect(optsArg()?.regenerateIsLast ?? false).toBe(false)
    /* 但重跑本身照旧：它会把后面那轮撤掉（既有语义） */
    expect(calls().length).toBe(1)
  })
})

describe('流式中重新生成（验收 b）', () => {
  it('b · 先中止旧流、排队；收尾后自动开跑（不抢上下文、只有一轮新生成）', async () => {
    seed([
      thread('t1', [
        msg({ id: 'q-b', role: 'user', content: '整理一份清单', timestamp: 100 }),
        msg({ id: 'ans-b', diskKey: 'dk-b', content: '写到一半…', timestamp: 200 }),
      ]),
    ])
    useThreadStore.setState({ sendingThreads: ['t1'] })
    useThreadStore.getState().regenerateMessage('ans-b')

    /* 点的时候：中止旧请求 + 排队 + 提示；还没有开新的 */
    expect(vi.mocked(stopActiveRequest).mock.calls).toEqual([['t1']])
    expect(calls().length).toBe(0)
    expect(hasPendingRegen('t1')).toBe(true)
    expect(useUIStore.getState().toasts[0]?.title).toBe('先停掉当前这轮')

    /* 旧轮真正收尾（turns.finish 会先清 sendingThreads 再调 drain）→ 自动开跑 */
    useThreadStore.setState({ sendingThreads: [] })
    drainPendingRegen('t1')
    await flush()
    expect(calls().length).toBe(1)
    expect(optsArg()?.reason).toBe('重新生成')
    expect(hasPendingRegen('t1')).toBe(false)
    /* 全程只有一次新生成 —— 中止的那轮不会有第二次 */
    expect(vi.mocked(stopActiveRequest).mock.calls.length).toBe(1)
  })
})

describe('连续重新生成限制（验收 e）', () => {
  it('e · 前 5 次不提示；第 6 次提示「换个方向」', () => {
    for (let i = 1; i <= 6; i += 1) {
      /* 每次重新播种：上一次重跑已经把旧回答从内存换掉了（真实流程里换成新占位） */
      seed([
        thread('t1', [
          msg({ id: 'q-e', role: 'user', content: '同一个问题', timestamp: 100 }),
          msg({ id: 'ans-e', diskKey: 'dk-e', content: `第 ${i} 版回答`, timestamp: 200 }),
        ]),
      ])
      useThreadStore.getState().regenerateMessage('ans-e')
    }
    expect(calls().length).toBe(6)
    const toasts = useUIStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe('已经连续重新生成 6 次')
  })
})

describe('切对话不触发生成（验收 g）', () => {
  it('g · A→B→A：一次都不跑（刚修好的 bug 不许回归）', async () => {
    seed([
      thread('t1', [
        msg({ id: 'q-g', role: 'user', content: 'A 完事', timestamp: 100 }),
        msg({ id: 'ans-g', content: 'A 的回复', timestamp: 200 }),
      ]),
      thread('t2', []),
    ])
    useAppStore.getState().setActiveThread('t2')
    await flush()
    useAppStore.getState().setActiveThread('t1')
    await flush()
    expect(calls().length).toBe(0)
    expect(vi.mocked(stopActiveRequest).mock.calls.length).toBe(0)
  })
})
