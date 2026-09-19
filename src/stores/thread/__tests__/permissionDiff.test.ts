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
