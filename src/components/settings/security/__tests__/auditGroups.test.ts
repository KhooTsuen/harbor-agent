import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '@/types/backend'
import { groupAudit, runLabel, type AuditRun } from '../auditGroups'

/* ══════════════════════════════════════════════════════════════
   审计折叠（真机反馈 8）：会话 → 任务 → 同类调用
   ══════════════════════════════════════════════════════════════ */

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  ts: 1,
  sessionId: 's1',
  taskId: 't1',
  tool: 'read_file',
  permission: 'ask',
  approval: null,
  startedAt: 1,
  finishedAt: 2,
  ms: 1,
  ok: true,
  error: '',
  affectedFiles: [],
  networkTarget: '',
  ...over,
})

describe('审计折叠', () => {
  it('★ 同一会话 + 同一任务 + 同一工具 → 折成一组，且新的在前', () => {
    const groups = groupAudit([entry({ ts: 1 }), entry({ ts: 2 }), entry({ ts: 3 })])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(3)
    expect(groups[0]?.tasks).toHaveLength(1)
    expect(groups[0]?.tasks[0]?.runs).toHaveLength(1)
    expect(runLabel(groups[0]!.tasks[0]!.runs[0]!)).toBe('read_file × 3')
    expect(groups[0]?.tasks[0]?.runs[0]?.entries.map((e) => e.ts)).toEqual([3, 2, 1])
  })

  it('不同工具在同一次任务里分成不同的组', () => {
    const groups = groupAudit([
      entry({ ts: 1, tool: 'read_file' }),
      entry({ ts: 2, tool: 'run_shell' }),
      entry({ ts: 3, tool: 'read_file' }),
    ])
    const runs = groups[0]?.tasks[0]?.runs ?? []
    expect(runs.map((r) => r.tool).sort()).toEqual(['read_file', 'run_shell'])
    expect(runLabel(runs.find((r) => r.tool === 'read_file') as AuditRun)).toBe('read_file × 2')
  })

  it('不同会话分开，会话之间按最新那条排（最新的在上面）', () => {
    const groups = groupAudit([
      entry({ ts: 1, sessionId: 'old' }),
      entry({ ts: 9, sessionId: 'new' }),
    ])
    expect(groups.map((g) => g.sessionId)).toEqual(['new', 'old'])
  })

  it('同一会话里的两个任务分开', () => {
    const groups = groupAudit([
      entry({ ts: 1, taskId: 't1' }),
      entry({ ts: 2, taskId: 't2' }),
      entry({ ts: 3, taskId: 't1' }),
    ])
    expect(groups[0]?.tasks.map((t) => t.taskId)).toEqual(['t1', 't2'])
    expect(groups[0]?.tasks[0]?.count).toBe(2)
  })

  it('没会话 / 没任务归属的**不丢**，归到「没指定」那一桶', () => {
    const groups = groupAudit([
      entry({ ts: 1, sessionId: '', taskId: '' }),
      entry({ ts: 2, sessionId: 's1', taskId: '' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.sessionId).sort()).toEqual(['', 's1'])
    expect(groups.find((g) => g.sessionId === 's1')?.tasks[0]?.taskId).toBe('')
  })

  it('失败次数与耗时按组累计', () => {
    const groups = groupAudit([
      entry({ ts: 1, ok: false, ms: 30 }),
      entry({ ts: 2, ok: true, ms: 12 }),
    ])
    expect(groups[0]?.failed).toBe(1)
    expect(groups[0]?.tasks[0]?.runs[0]?.failed).toBe(1)
    expect(groups[0]?.tasks[0]?.runs[0]?.totalMs).toBe(42)
  })

  it('只有一次就不写「×1」', () => {
    expect(runLabel({ tool: 'run_shell', entries: [], failed: 0, totalMs: 0 })).toBe('run_shell')
  })
})
