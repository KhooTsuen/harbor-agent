import { describe, expect, it } from 'vitest'
import { handleStreamEvent, type StreamState } from '../streamEvents'
import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   工具「结果未确认」（2026-11-09）

   ── 病 ────────────────────────────────────────────────────────
   `agent.tool.started` 建记录时只能先乐观填 `ok: true`（那时还不知道成败）。
   若用户在工具跑完前按了停止、或者进程被强杀，磁盘快照里就是
   「一条 ok:true 的工具」—— 重启后界面画成**成功绿勾**，
   而这次调用其实**结果未知**（可能写了一半文件、可能压根没跑）。

   界面把「不知道」画成「成功」，和之前那些「未知显示成 0」是同一类病。

   ── 修法 ──────────────────────────────────────────────────────
   started 时置 `pending: true`；completed / failed 拿到结果后删掉它。
   读回后 `pending === true` = 「跑了，但不知道结果」，界面必须如实说。

   ── 为什么这条要单测 ──────────────────────────────────────────
   这个字段只在**异常路径**（中途被杀）才有意义，正常跑永远看不到 ——
   不钉住的话，谁哪天把 `delete updated.pending` 删了也没人知道。
   ══════════════════════════════════════════════════════════════ */

function makeState(): { state: StreamState; patched: () => ToolRunRecord[] } {
  let last: ToolRunRecord[] = []
  const state: StreamState = {
    content: '',
    reasoning: '',
    toolRuns: [],
    rounds: [] as MessageRound[],
    citations: [],
    threadId: 'thread-1',
    patch: (fields) => {
      if (fields.toolRuns) last = fields.toolRuns as ToolRunRecord[]
    },
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
  return { state, patched: () => last }
}

describe('工具未确认 / pending 标记', () => {
  it('★★★ 工具刚开始 → pending=true（这时还不知道成败）', () => {
    const { state, patched } = makeState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'tc1', name: 'write_file', args: { path: 'a' } },
      state,
    )
    const runs = patched()
    expect(runs).toHaveLength(1)
    expect(runs[0].pending).toBe(true)
    /* 乐观的 ok 仍是 true —— 但**有 pending 在**，界面不许据此画绿勾 */
    expect(runs[0].ok).toBe(true)
  })

  it('★★★ 工具完成 → pending 被删掉（有结果了就是确认过）', () => {
    const { state, patched } = makeState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'tc1', name: 'read_file', args: {} },
      state,
    )
    handleStreamEvent(
      {
        type: 'agent.tool.completed',
        toolCallId: 'tc1',
        name: 'read_file',
        ok: true,
        result: 'ok',
        ms: 12,
      },
      state,
    )
    const runs = patched()
    expect(runs[0].pending).toBeUndefined()
    expect(runs[0].ok).toBe(true)
  })

  it('★★ 工具失败 → 同样清掉 pending（失败也是**确认过**的结果）', () => {
    const { state, patched } = makeState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'tc2', name: 'run_shell', args: {} },
      state,
    )
    handleStreamEvent(
      {
        type: 'agent.tool.failed',
        toolCallId: 'tc2',
        name: 'run_shell',
        ok: false,
        result: '错误：退出码 1',
        ms: 30,
      },
      state,
    )
    const runs = patched()
    expect(runs[0].pending).toBeUndefined()
    expect(runs[0].ok).toBe(false)
  })

  it('★★★ 中途被杀：state 里那条仍是 pending（这就是重启后能看出来的证据）', () => {
    const { state } = makeState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'tc3', name: 'write_file', args: {} },
      state,
    )
    /* 没有 completed —— 模拟进程在这里被强杀，state 就是最后要落盘的东西 */
    expect(state.toolRuns[0].pending).toBe(true)
  })

  it('★★ 多工具只完成了一部分 → 未完成的那些仍是 pending', () => {
    const { state, patched } = makeState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'a', name: 'read_file', args: {} },
      state,
    )
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'b', name: 'write_file', args: {} },
      state,
    )
    handleStreamEvent(
      { type: 'agent.tool.completed', toolCallId: 'a', name: 'read_file', ok: true, result: 'ok' },
      state,
    )
    const runs = patched()
    expect(runs.find((r) => r.id === 'a')?.pending).toBeUndefined()
    expect(runs.find((r) => r.id === 'b')?.pending).toBe(true)
  })
})
