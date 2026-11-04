import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DiffFile } from '@/types'
import { useUIStore } from '@/stores/useUIStore'
import { handleStreamEvent, type StreamState } from '../streamEvents'

/* ══════════════════════════════════════════════════════════════
   AG-036：确认事件 → 弹窗（这段接线单独测）

   为什么要单独一条：弹窗那一组是**直接往 store 里塞** permission 的，
   于是「主进程推过来的 diff 有没有被搬进 permission」谁都没盯着 ——
   把 `diff:` 那一行删掉，那边 6 条断言照样全绿（变异测试逮到的）。
   ══════════════════════════════════════════════════════════════ */

const DIFF: DiffFile[] = [
  {
    path: 'E:/demo/README.md',
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { type: 'remove', content: '旧的', oldLineNumber: 1 },
          { type: 'add', content: '新的', newLineNumber: 1 },
        ],
      },
    ],
  },
]

/** confirm_request 这一支只用到 threadId（其余字段给全是为了类型） */
const state = (): StreamState => ({
  content: '',
  reasoning: '',
  toolRuns: [],
  rounds: [],
  citations: [],
  threadId: 'thread-1',
  patch: () => {},
  snapshot: () => ({
    id: 'm1',
    threadId: 'thread-1',
    role: 'assistant',
    kind: 'text',
    content: '',
    status: 'streaming',
    timestamp: 0,
  }),
  finish: () => {},
  /* 重试回滚起点（本组只测确认卡，给个 0 起点即可） */
  retryMarks: { text: 0, think: 0, round: -1, roundText: 0, roundThink: 0 },
})

beforeEach(() => {
  useUIStore.setState({ permission: null })
})

describe('AG-036 / 确认事件带着 diff 进弹窗', () => {
  it('★ 事件里的 diff 会被搬进 permission（弹窗靠它显示「查看 Diff」）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_1',
          toolName: 'write_file',
          summary: '写文件 README.md',
          args: { path: 'README.md' },
          kind: 'write',
          diff: DIFF,
          diffNote: '这是新文件（原来不存在）',
        },
        state(),
      )
    })

    const permission = useUIStore.getState().permission
    expect(permission?.diff).toHaveLength(1)
    expect(permission?.diff?.[0]?.path).toContain('README.md')
    expect(permission?.diffNote).toBe('这是新文件（原来不存在）')
  })

  it('没有 diff 的事件照旧（跑命令那种）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_2',
          toolName: 'run_shell',
          summary: '执行命令：npm test',
          args: { command: 'npm test' },
          kind: 'risk',
        },
        state(),
      )
    })
    expect(useUIStore.getState().permission?.diff).toBeUndefined()
    expect(useUIStore.getState().permission?.title).toContain('执行命令')
  })
})

/* ══════════════════════════════════════════════════════════════
   卡片文案 ↔ 内核行为对齐（2026-11-05）

   内核 `mcp-gate.cjs` 现在**完全不记** MCP 的批准（能力分级不可靠，
   一次确认只能授权它显示的那一次调用）；`approval.cjs` 的 `REMEMBERED`
   里也只剩 `write`。卡片上要是还写着「同意后本轮内同类操作不再询问」，
   那就是界面在承诺一件内核不会做的事 —— 用户按这句话预期不再被问，
   结果每次都要点，会以为卡坏了。

   这条必须测「界面真的渲染出的那句话」，不能只测常量：
   把 `perCall` 那行删掉，只测内核的话这里照样绿（就是那种假绿）。
   ══════════════════════════════════════════════════════════════ */

describe('2026-11-05 / 确认卡说的「会不会再问」必须与内核一致', () => {
  it('★ MCP 的卡：不承诺「不再询问」，明说只对这一次有效', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_mcp',
          toolName: 'mcp__filesystem__read_file',
          summary: '调用 MCP 工具 mcp__filesystem__read_file',
          args: { path: 'a.txt' },
          kind: 'mcp',
        },
        state(),
      )
    })
    const text = useUIStore.getState().permission?.description ?? ''
    expect(text).not.toContain('不再询问')
    expect(text).toContain('只对这一次调用有效')
  })

  it('write 的卡仍然承诺「本轮内同类不再询问」（那一档内核确实会记）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_write',
          toolName: 'write_file',
          summary: '写文件 README.md',
          args: { path: 'README.md' },
          kind: 'write',
        },
        state(),
      )
    })
    const text = useUIStore.getState().permission?.description ?? ''
    expect(text).toContain('本轮')
    expect(text).toContain('不再询问')
    expect(text).not.toContain('只对这一次调用有效')
  })

  it('alwaysAsk（Codex 经 MCP 的写路径）仍然说「每一次都会单独询问」', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_codex',
          toolName: 'write_file',
          summary: '写文件 README.md',
          args: { path: 'README.md' },
          kind: 'write',
          alwaysAsk: true,
        },
        state(),
      )
    })
    const text = useUIStore.getState().permission?.description ?? ''
    expect(text).toContain('每一次都会单独询问')
    expect(text).not.toContain('本轮')
  })
})
