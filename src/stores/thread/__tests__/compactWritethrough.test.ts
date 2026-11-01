import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Thread } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { appendCompact } from '@/lib/compactApi'
import { runCompact } from '../compact'
import { buildHistory } from '../history'

/* ══════════════════════════════════════════════════════════════
   P0-2「假压缩成功」+ 正常前端发送的最终请求（2026-10-23）

   两件事在同一个文件里，因为它们共用一份夹具，而且都是「界面/请求到底真的
   发生了什么」这一类断言 —— 不是在测纯函数算得对。

   ① `appendCompact` 以前返回 `void`，桥抛错被空 catch 吞掉 → `runCompact`
      照样插压缩点、弹「已压缩」，磁盘上却没有摘要。现在必须**如实返回**。
   ② `runCompact` 只有确认写盘成功才允许改界面（插压缩点 / 弹成功）。
   ③ 正常前端发送：`buildHistory`（渲染层拼形状）→ `windowHistory`（主进程按轮次
      切）→ `buildChatBody`（llm.cjs 真正发出去的 body）→ JSON。断言的三个要点是
      上一轮的目标 / 约束 / 结论，看的**不是** `session.toApiMessages` 那条磁盘路。
   ══════════════════════════════════════════════════════════════ */

/* 桥：默认写成功，可逐个用例替换（vi.hoisted 保证在工厂执行时已存在） */
const h = vi.hoisted(() => ({
  append: async (
    _id: string,
    _summary: string,
    _upTo: number,
  ): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
}))

vi.mock('@/lib/bridge', () => ({
  bridge: {
    appendCompact: (id: string, summary: string, upTo: number) => h.append(id, summary, upTo),
  },
  isElectron: true,
  useRealBackend: true,
}))

/* runCompact 依赖 backend 的两个出口；桥那层已在上面单独覆盖，这里给「已知结果」 */
const backend = vi.hoisted(() => ({
  compact: async (): Promise<{ ok: boolean; summary?: string; error?: string }> => ({
    ok: true,
    summary: '## Goal\n把这件事做完',
  }),
  append: async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
}))
vi.mock('@/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend')>()),
  compactChat: () => backend.compact(),
  appendCompact: () => backend.append(),
}))

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const windowCore = require_(join(ROOT, 'electron/core/history-window.cjs')) as {
  takeTurns: (m: unknown[], budget: number, o?: object) => { kept: unknown[] }
}
const bodyCore = require_(join(ROOT, 'electron/core/llm-body.cjs')) as {
  buildChatBody: (input: object) => object
}

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

beforeEach(() => {
  h.append = async () => ({ ok: true })
  backend.compact = async () => ({ ok: true, summary: '## Goal\n把这件事做完' })
  backend.append = async () => ({ ok: true })
  useUIStore.setState({ toasts: [] })
  useAppStore.setState({ threads: [], activeThreadId: 't1', projects: [] } as never)
})

describe('appendCompact：写盘结果如实返回', () => {
  it('★ 桥返回 ok:true → ok:true', async () => {
    h.append = async () => ({ ok: true })
    await expect(appendCompact('t1', '摘要', 3)).resolves.toEqual({ ok: true })
  })

  it('★★ 桥返回 ok:false → 原样报失败（以前是吞掉）', async () => {
    h.append = async () => ({ ok: false, error: '磁盘满了' })
    const result = await appendCompact('t1', '摘要', 3)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('磁盘满了')
  })

  it('★★ 桥抛异常 → 翻成 ok:false（不往外抛，也不当成功）', async () => {
    h.append = async () => {
      throw new Error('IPC 断了')
    }
    const result = await appendCompact('t1', '摘要', 3)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('IPC 断了')
  })

  it('★ 桥返回 {ok:true} 但没确认字段 → 只认 ok === true（undefined 不算成功）', async () => {
    h.append = async () => ({}) as unknown as { ok: boolean }
    const result = await appendCompact('t1', '摘要', 3)
    expect(result.ok).toBe(false)
  })
})

describe('runCompact：只有写盘确认成功才改界面', () => {
  const many = () =>
    Array.from({ length: 12 }, (_, i) =>
      msg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条内容` }),
    )

  it('★★ 写盘失败：不插压缩点、不弹「已压缩」、返回失败', async () => {
    useAppStore.setState({
      threads: [thread('t1', many())],
      activeThreadId: 't1',
      projects: [],
    } as never)
    backend.append = async () => ({ ok: false, error: '会话文件写不进去' })

    const result = await runCompact('t1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('会话文件写不进去')

    const after = useAppStore.getState().threads[0]!.messages
    expect(after.filter((m) => m.compactUpTo)).toHaveLength(0)
    expect(after).toHaveLength(12)
    const titles = useUIStore.getState().toasts.map((t) => t.title)
    expect(titles).not.toContain('已压缩')
    expect(titles).toContain('压缩失败')
  })

  it('★★ 写成功：插一条压缩点 + 弹一次「已压缩」', async () => {
    useAppStore.setState({
      threads: [thread('t1', many())],
      activeThreadId: 't1',
      projects: [],
    } as never)

    const result = await runCompact('t1')
    expect(result.ok).toBe(true)

    const after = useAppStore.getState().threads[0]!.messages
    const markers = after.filter((m) => m.compactUpTo)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.compactUpTo).toBe(6)
    expect(markers[0]!.reasoning).toContain('把这件事做完')
    const titles = useUIStore.getState().toasts.map((t) => t.title)
    expect(titles).toContain('已压缩')
  })

  it('摘要生成本身失败 → 不动磁盘、不动界面', async () => {
    useAppStore.setState({
      threads: [thread('t1', many())],
      activeThreadId: 't1',
      projects: [],
    } as never)
    backend.compact = async () => ({ ok: false, error: '模型没回来' })

    const result = await runCompact('t1')
    expect(result.ok).toBe(false)
    expect(useAppStore.getState().threads[0]!.messages).toHaveLength(12)
    expect(useUIStore.getState().toasts.map((t) => t.title)).toContain('压缩失败')
  })
})

describe('正常前端发送的最终请求（不是磁盘那条路）', () => {
  const GOAL = '目标：把 userStore 拆成两个文件'
  const LIMIT = '不要改 public API'
  const CONCLUSION = '结论：拆完了，npm test 全绿'

  /** 跑过 n 次工具的一条助手消息（渲染层的形状：toolRuns） */
  const ran = (n: number): Message =>
    msg({
      id: 'ans-1',
      diskKey: 'dk-ans-1',
      content: `${CONCLUSION}（跑了 ${n} 次）`,
      toolRuns: Array.from({ length: n }, (_, i) => ({
        id: `run-${i}`,
        name: 'run_shell',
        ok: true,
        output: `out#${i}`,
      })),
    })

  for (const n of [0, 1, 30, 100]) {
    it(`★★ ${n} 次工具调用：目标 / 约束 / 结论都在实际请求载荷里`, () => {
      const messages: Message[] = [
        msg({ id: 'q-1', role: 'user', content: `${GOAL}\n约束：${LIMIT}。`, timestamp: 1 }),
        ran(n),
        msg({ id: 'q-2', role: 'user', content: '那个地方接着改', timestamp: 3 }),
      ]
      /* 渲染层拼形状 → 主进程按轮次切（默认 20 条）→ 发出去的那个 body */
      const history = buildHistory(messages, '')
      const { kept } = windowCore.takeTurns(history, 20, { minTurns: 1 })
      const payload = JSON.stringify(bodyCore.buildChatBody({ model: 'probe', messages: kept }))

      expect(payload).toContain(GOAL)
      expect(payload).toContain(LIMIT)
      expect(payload).toContain(CONCLUSION)
      expect(payload).toContain('那个地方接着改')
    })
  }

  it('★ 工具组不会被切半（载荷里 tool 与 tool_calls 成对）', () => {
    const messages: Message[] = [
      msg({ id: 'q-1', role: 'user', content: '读一堆文件', timestamp: 1 }),
      ran(30),
      msg({ id: 'q-2', role: 'user', content: '那个地方接着改', timestamp: 3 }),
    ]
    const { kept } = windowCore.takeTurns(buildHistory(messages, ''), 20, { minTurns: 1 })
    const list = kept as Array<{
      role: string
      tool_calls?: Array<{ id: string }>
      tool_call_id?: string
    }>
    const callIds = new Set(list.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)))
    const tools = list.filter((m) => m.role === 'tool')
    expect(tools.filter((m) => !callIds.has(m.tool_call_id ?? '')).length).toBe(0)
    expect([...callIds].filter((id) => !tools.some((m) => m.tool_call_id === id)).length).toBe(0)
  })

  it('★ 压缩点摘要也走这条正常发送路（渲染层那份）', () => {
    const messages: Message[] = [
      msg({ id: 'old-1', role: 'user', content: '很早的问题', timestamp: 1 }),
      msg({ id: 'old-2', role: 'assistant', content: '很早的回答', timestamp: 2 }),
      msg({
        id: 'cp',
        role: 'system',
        content: '已压缩前 2 条对话',
        compactUpTo: 2,
        reasoning: '## Goal\n把这件事做完',
        timestamp: 3,
      }),
      msg({ id: 'q-3', role: 'user', content: '压过之后的问题', timestamp: 4 }),
    ]
    const history = buildHistory(messages, '')
    const payload = JSON.stringify(bodyCore.buildChatBody({ model: 'probe', messages: history }))
    expect(payload).toContain('把这件事做完')
    expect(payload).not.toContain('很早的问题')
  })
})
