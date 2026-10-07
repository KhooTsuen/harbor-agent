import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/stores/useUIStore'
import { handleStreamEvent, type StreamState } from '../streamEvents'

/* ══════════════════════════════════════════════════════════════
   P0-5：渲染层按 `decisionType` 分流（不再靠 `kind` 猜）

   `kind` 是个**一词两义**的字段：审批的 `kind` 是工具种类（write/mcp/…），
   澄清的 `kind` 恒为 'clarify'。渲染层早先拿 `kind === 'clarify'` 当分流判据 ——
   能跑，但两个值域挤一个字段名（硬约束 9 要消灭的）。主进程现在给
   `decisionType`（'approval' | 'clarify'），这里钉住：判据用的是它，
   且老主进程（没带 decisionType）时退回看 kind，界面不会失能。
   ══════════════════════════════════════════════════════════════ */

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
})

const QUESTIONS = [{ question: '用哪个？', options: [{ label: 'a', effect: '多花 1 秒' }] }]

beforeEach(() => {
  useUIStore.setState({ permission: null, clarify: null })
})

describe('P0-5 / 分流判据：decisionType 优先', () => {
  it('★ decisionType=clarify → 进澄清槽位（不进权限槽位）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          decisionType: 'clarify',
          confirmId: 'clr_1',
          sessionId: 'thread-1',
          questions: QUESTIONS,
        },
        state(),
      )
    })
    expect(useUIStore.getState().clarify?.confirmId).toBe('clr_1')
    expect(useUIStore.getState().permission).toBeNull()
  })

  it('★ decisionType=approval → 进权限槽位（即使 kind 也叫别的）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          decisionType: 'approval',
          confirmId: 'cfm_1',
          sessionId: 'thread-1',
          toolName: 'run_shell',
          kind: 'risk',
        },
        state(),
      )
    })
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_1')
    expect(useUIStore.getState().clarify).toBeNull()
  })
})

describe('P0-5 / 兼容：老主进程没带 decisionType 时退回看 kind', () => {
  it('没有 decisionType、kind=clarify → 仍然进澄清槽位（界面不失能）', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'clr_2',
          sessionId: 'thread-1',
          kind: 'clarify',
          questions: QUESTIONS,
        },
        state(),
      )
    })
    expect(useUIStore.getState().clarify?.confirmId).toBe('clr_2')
    expect(useUIStore.getState().permission).toBeNull()
  })

  it('没有 decisionType、kind=write → 进权限槽位', () => {
    act(() => {
      handleStreamEvent(
        {
          type: 'confirm_request',
          confirmId: 'cfm_2',
          sessionId: 'thread-1',
          toolName: 'write_file',
          kind: 'write',
        },
        state(),
      )
    })
    expect(useUIStore.getState().permission?.confirmId).toBe('cfm_2')
    expect(useUIStore.getState().clarify).toBeNull()
  })
})
