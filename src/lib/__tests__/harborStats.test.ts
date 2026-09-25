import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateHarborStats, isTestCommand } from '../harborStats'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   /harbor 统计：聚合 + 与内核「测试命令」口径的一致性

   统计只吃任务台账（设计文档 §13.4）。最容易漂的是「什么算测试」——
   渲染层这份 TEST_HINTS 必须和内核 `core/task-outcome.cjs` 同口径，
   所以这里直接读内核源码核对关键词（两边改一边会红）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: over.id ?? 't',
    title: 't',
    goal: 't',
    status: over.status ?? 'completed',
    mode: 'pair',
    sessionId: 's',
    projectId: '',
    workdir: '',
    plan: [],
    steps: [],
    checkpoints: [],
    changedFiles: [],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '',
    createdAt: 1,
    updatedAt: 1,
    finishedAt: 0,
    ...over,
  }
}

describe('/harbor 统计 / 聚合', () => {
  it('完成 / 中止 / 恢复次数 / 测试次数 都对', () => {
    const stats = aggregateHarborStats([
      task({ id: 'a', status: 'completed', resumeCount: 2 }),
      task({ id: 'b', status: 'cancelled' }),
      task({
        id: 'c',
        status: 'failed',
        commands: [
          { command: 'npm test', result: 'ok', at: 1, exitOk: true },
          { command: 'npm run build', result: 'ok', at: 2, exitOk: true },
          { command: 'vitest run', result: 'ok', at: 3, exitOk: true },
        ],
      }),
    ])
    expect(stats.completed).toBe(1)
    expect(stats.cancelled).toBe(1)
    expect(stats.resumed).toBe(2)
    /* npm run build 不算测试（与内核同口径） */
    expect(stats.testRuns).toBe(2)
  })

  it('最常用工具按台账里的 steps 数出来；没有步骤数据就是空', () => {
    const stats = aggregateHarborStats([
      task({
        id: 'a',
        steps: [
          { at: 1, tool: 'read_file', ok: true, ms: 1, summary: '' },
          { at: 2, tool: 'read_file', ok: true, ms: 1, summary: '' },
          { at: 3, tool: 'run_shell', ok: true, ms: 1, summary: '' },
        ],
      }),
      task({ id: 'b' }),
    ])
    expect(stats.topTool).toBe('read_file')
    expect(aggregateHarborStats([]).topTool).toBe('')
  })
})

describe('/harbor 统计 / 与内核同口径', () => {
  it('渲染层的测试命令判据与内核 task-outcome.cjs 一致', () => {
    const kernel = readFileSync(join(ROOT, 'electron/core/task-outcome.cjs'), 'utf8')
    for (const marker of ['vitest', 'pytest', 'cargo', 'make\\s+test', 'npm|pnpm|yarn|bun']) {
      expect(kernel, `内核里少了 ${marker}`).toContain(marker)
    }
    /* 样本命令两边都认 / 都不认 */
    expect(isTestCommand('npm test')).toBe(true)
    expect(isTestCommand('python tests.py')).toBe(true)
    expect(isTestCommand('cargo test --release')).toBe(true)
    expect(isTestCommand('npm run build')).toBe(false)
    expect(isTestCommand('git status')).toBe(false)
  })
})
