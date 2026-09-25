import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runElectronTurn } from '../turns'
import { appendMessage, loadSession } from '@/lib/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import type { Message, Thread } from '@/types'
import type { SessionDetail, StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   切换稳定性：**切版本 / 切对话都不许自己跑起来**

   用户报的 bug：AI 回复刚生成完，切走再切回来，它**又自己输出了一轮**。

   真机日志（E:\Harbor 的 actions-*.jsonl）里能一条条对上：
     · 09-23 19:28:30/31/35/37 连点「上一版 / 下一版」→ 每次都紧跟一个 `chat:send`
     · 09-25 09:26:57 点「上一版」→ session:load → `chat:send`（4 秒后用户点了「停止生成」）
   磁盘上还留着那次误触发产出的半截回答：`answersKey` 指向**重读之后才存在的新 uid**
   （msg_mugrbc4n0fw2gxq），而问题记录的 key 是 msg_mugr7m3lr7d0vs2 —— 就是本文件
   第一条用例复现的那个链路。

   根因见 `messageVersions.ts` 的 `activateUserVersion`：重读会把每条消息**换成新 uid**
   （`storedToUi` 里是 `uid('msg')`），重读前拿到的 id 重读后一定找不到 → 查找失败
   → 被当成「这一版没回答过」→ 自动 rerunFrom。jsdom 单测照不到它，因为这里
   `loadSession` 平时是 null（读不到 → 不重载 → id 恰好没变）。

   所以这里 mock 出「重载成功且换了 id」的真实形状，钉住三件事：
     ① 切回**回答过的版本**：一次模型都不跑（纯换显示）
     ② 切到**没回答过的版本**：也不自动跑，只提示；点「补一版回答」才跑
     ③ 写盘要写回磁盘 key（不然文件里会多出一条同名提问）
   （「切对话」那条路径在 switchNoRegenThreads.test.ts，两边各自自包含）
   ══════════════════════════════════════════════════════════════ */

vi.mock('../turns', () => ({ runElectronTurn: vi.fn(async () => {}) }))
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
const optsArg = () => calls().at(-1)?.[4] as { seedAnswers?: StoredMessage[]; reason?: string }

/** 两条消息都在磁盘上的样子（重载读到的形状） */
const rec = (key: string, content: string, version: number): StoredMessage => ({
  role: 'assistant',
  key,
  content,
  answersVersion: version,
  ts: 200,
})

function detail(messages: StoredMessage[]): SessionDetail {
  return {
    meta: { type: 'meta', id: 't1', title: '自检对话', mode: 'pair', model: 'probe', createdAt: 1 },
    messages,
  }
}

/** 一段对话：一条改过两版的提问 + 它的回答（回答是哪一版由调用方定） */
function twoVersionThread(over: { answeredOnlyV1?: boolean } = {}): Thread {
  const records: StoredMessage[] = [rec('a0', '答第一版', 0), rec('a1', '答第二版', 1)]
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
      ...(over.answeredOnlyV1 ? {} : { answerRecords: records, answerIndex: 1 }),
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
  vi.mocked(appendMessage).mockClear()
  useThreadStore.setState({ sendingThreads: [] })
  useUIStore.setState({ toasts: [] })
  seed([twoVersionThread()])
})

describe('切提问版本（真后端：先写盘、再重读）', () => {
  it('★ 切回「回答过的版本」：重读换了 id 也要能认出它 —— 一次模型都不跑', async () => {
    /* 重读拿到的形状：提问已经停在第 0 版，后面跟着第 0 版的回答 */
    vi.mocked(loadSession).mockResolvedValue(
      detail([
        {
          role: 'user',
          key: 'u1',
          content: '第一版',
          ts: 100,
          versions: ['第一版', '第二版'],
          versionIndex: 0,
        },
        {
          role: 'assistant',
          key: 'a0',
          content: '答第一版',
          ts: 200,
          answersKey: 'u1',
          answersVersion: 0,
          answerRecords: [rec('a0', '答第一版', 0), rec('a1', '答第二版', 1)],
          answerIndex: 0,
        },
      ]),
    )
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    await flush()
    /* ★ 修之前这里是 1：重读换 id → 找不到 → 被当成没回答过 → 又跑一轮 */
    expect(calls().length).toBe(0)
    /* 回答过 → 安安静静，连提示都不弹 */
    expect(useUIStore.getState().toasts.length).toBe(0)
    /* 视图确实换到了第一版（重读生效，而不是什么都没做） */
    const msgs = useAppStore.getState().threads[0]!.messages
    expect(msgs[0]!.content).toBe('第一版')
    expect(msgs[1]!.content).toBe('答第一版')
  })

  it('★ 切到「没回答过的版本」：也不自动跑 —— 提示 + 点「补一版回答」才跑', async () => {
    seed([twoVersionThread({ answeredOnlyV1: true })])
    /* 重读拿到的形状：提问停在第 0 版，后面**什么回答都没有**（内核按版本筛掉了） */
    vi.mocked(loadSession).mockResolvedValue(
      detail([
        {
          role: 'user',
          key: 'u1',
          content: '第一版',
          ts: 100,
          versions: ['第一版', '第二版'],
          versionIndex: 0,
        },
      ]),
    )
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    await flush()
    /* ★ 修之前这里是 1（用户看到的就是「切个版本它又自己跑起来」） */
    expect(calls().length).toBe(0)

    const toast = useUIStore.getState().toasts[0]
    expect(toast?.title).toBe('这一版还没有回答过')
    expect(toast?.action?.label).toBe('补一版回答')

    /* 用户明确点了才跑 —— 而且写盘/重跑用的是**磁盘 key**（u1 是磁盘 key，新 uid 只在内存里） */
    toast?.action?.onClick()
    await flush()
    expect(calls().length).toBe(1)
    expect(optsArg()?.reason).toBe('补一版回答')
    expect(vi.mocked(appendMessage).mock.calls.at(-1)?.[1]?.key).toBe('u1')
  })

  it('正在生成时切版本：直接拒绝（和「继续」一个规矩，别抢上下文）', () => {
    useThreadStore.setState({ sendingThreads: ['t1'] })
    useThreadStore.getState().activateUserVersion('t1', 'u1', 0)
    expect(calls().length).toBe(0)
    expect(useUIStore.getState().toasts[0]?.title).toBe('正在生成')
  })

  it('★ 写盘写回「磁盘 key」，不是重读后的新 uid —— 不然文件里会多出一条同名提问', async () => {
    /* 开机后内存 id 是新的（u-boot），磁盘 key 是原来那个（dk-old） */
    seed([
      thread('t1', [
        msg({
          id: 'u-boot',
          diskKey: 'dk-old',
          role: 'user',
          content: '第二版',
          versions: ['第一版', '第二版'],
          versionIndex: 1,
          timestamp: 100,
        }),
        msg({
          id: 'a1',
          content: '答第二版',
          answersKey: 'dk-old',
          answersVersion: 1,
          timestamp: 200,
        }),
      ]),
    ])
    vi.mocked(loadSession).mockResolvedValue(
      detail([
        {
          role: 'user',
          key: 'dk-old',
          content: '第一版',
          ts: 100,
          versions: ['第一版', '第二版'],
          versionIndex: 1,
        },
        {
          role: 'assistant',
          key: 'a0',
          content: '答第一版',
          ts: 200,
          answersKey: 'dk-old',
          answersVersion: 0,
          answerRecords: [rec('a0', '答第一版', 0)],
        },
      ]),
    )
    useThreadStore.getState().activateUserVersion('t1', 'u-boot', 0)
    await flush()
    /* 写 dk-old 才能把原来那条提问的 versionIndex 改掉；写 u-boot 就多一条同名副本 */
    expect(vi.mocked(appendMessage).mock.calls[0]?.[1]?.key).toBe('dk-old')
    /* 这一版回答过（重读后有它那一版的回答）→ 安静，一次模型都不跑 */
    expect(calls().length).toBe(0)
  })
})
