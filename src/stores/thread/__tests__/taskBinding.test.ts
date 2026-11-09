import { describe, expect, it } from 'vitest'
import { handleStreamEvent, type StreamState } from '../streamEvents'

/* ══════════════════════════════════════════════════════════════
   任务绑定：`task` 事件是归属的唯一来源（2026-11-09）

   ── 为什么不能拿请求参数当归属 ────────────────────────────────
   请求里的 `resumeTaskId` 只是「我想接着那条做」。主进程会用
   `task-attribution.decide()` 再判一次，而那条约可能已经 completed / 被删 ——
   这时 `decide()` 返回 `{ kind: 'new' }`，主进程**新建一条任务**，返回的
   `task.id` 和请求里的 `resumeTaskId` 是两个不同的值。

   拿请求参数落盘，重启后就会说「这次执行属于任务 A」，而实际上 A 根本没跑过，
   真正跑的是 B —— 比留空更难查。

   ── 事件顺序 ──────────────────────────────────────────────────
   `loop-run.cjs` 建好台账**立刻**发 `task`（早于第一轮 turn_start），
   所以流式过程中就能挂上；收尾落盘时 `current()` 现取，能拿到。

   ── 没有事件就不猜 ────────────────────────────────────────────
   协作（`runCollaboration`）那条路不建任务台账，不发 `task` ——
   那种执行就是「没有任务归属」，字段留空，不拿会话里最近的任务凑数。
   ══════════════════════════════════════════════════════════════ */

/** 最小 StreamState（与 decisionRouting.test.ts 同形状） */
function state(patchOf: (fields: Record<string, unknown>) => void): StreamState {
  return {
    content: '',
    reasoning: '',
    toolRuns: [],
    rounds: [],
    citations: [],
    threadId: 'thread-1',
    patch: (fields) => patchOf(fields as Record<string, unknown>),
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
    retryMarks: { text: 0, think: 0, round: -1, roundText: 0, roundThink: 0 },
  }
}

describe('任务绑定 / task 事件', () => {
  it('★★★ 主进程回送的 taskId 挂到消息上（不是请求里的 resumeTaskId）', () => {
    let seen: Record<string, unknown> = {}
    const handled = handleStreamEvent(
      { type: 'task', taskId: 'task_real', changeSetId: 'cs_1', goal: '查两个文件', seq: 1 },
      state((f) => {
        seen = { ...seen, ...f }
      }),
    )
    expect(handled.handled).toBe(true)
    expect(seen.execTaskId).toBe('task_real')
  })

  it('★★★ 请求想恢复 A、主进程实际建了 B → 落盘记的是 B', () => {
    /* 这条钉的是「不接受请求参数」：resumeTaskId=A 只在 payload 里，
       事件只带真实 taskId。渲染层拿不到 A，也不能自己补。 */
    let seen: Record<string, unknown> = {}
    handleStreamEvent(
      { type: 'task', taskId: 'task_B', seq: 1 },
      state((f) => {
        seen = { ...seen, ...f }
      }),
    )
    expect(seen.execTaskId).toBe('task_B')
    expect(seen.execTaskId).not.toBe('task_A')
  })

  it('★★ 没有 task 事件（协作 / 老主进程）→ 不挂字段，不猜最近任务', () => {
    let patched = false
    const handled = handleStreamEvent(
      { type: 'turn_start', turn: 1, seq: 2 },
      state(() => {
        patched = true
      }),
    )
    expect(handled.handled).toBe(true)
    /* turn_start 会 patch rounds，但**不该**带 execTaskId */
    expect(patched).toBe(true)
  })

  it('★★ taskId 是空串 → 不写空值（防呆：别写个假归属进去）', () => {
    let seen: Record<string, unknown> = {}
    handleStreamEvent(
      { type: 'task', taskId: '', seq: 1 },
      state((f) => {
        seen = { ...seen, ...f }
      }),
    )
    expect(seen.execTaskId).toBeUndefined()
  })

  it('★★ 同一执行里 task 只来一次；重复来 → 后到的覆盖（仍绑真实那条）', () => {
    let seen: Record<string, unknown> = {}
    const s = state((f) => {
      seen = { ...seen, ...f }
    })
    handleStreamEvent({ type: 'task', taskId: 'task_1', seq: 1 }, s)
    handleStreamEvent({ type: 'task', taskId: 'task_2', seq: 2 }, s)
    expect(seen.execTaskId).toBe('task_2')
  })
})
