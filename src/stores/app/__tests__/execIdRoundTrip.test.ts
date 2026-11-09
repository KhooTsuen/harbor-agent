import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { storedToUi } from '../disk'

/* ══════════════════════════════════════════════════════════════
   执行身份与验收结论的端到端往返

   ── 为什么单独一条（2026-11-09 真机逮到）────────────────────────
   真机探针读到 `verdict = 'partial'`，但 `execId = (无)`。
   两者在 `disk.ts` 的映射里**紧挨着两行**，一个能回来一个不能 ——
   这种「存了但读回时不带」在这个项目里已经发生过好几次
   （思考过程、图片、clarify 都栽过），必须有一条机检钉住。

   这条从**磁盘行**开始走：JSON 行 → collapseByKey → groupAnswers → storedToUi。
   少走任何一环都测不出真实读路径的漏字段。
   ══════════════════════════════════════════════════════════════ */

const { collapseByKey } = require('../../../../electron/core/session-collapse.cjs') as {
  collapseByKey: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
}
const { groupAnswers } = require('../../../../electron/core/session-answers.cjs') as {
  groupAnswers: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
}

const ROUNDS = [
  { reasoning: '', content: '第一段：先说清楚我要查什么。', tools: [] },
  { reasoning: '看一眼', content: '', tools: [0] },
  { reasoning: '', content: '结论：两个文件都没问题，可以继续。', tools: [] },
]

/** 真机那份种子文件的形状：一个提问 + 一条带执行身份的完整回复 */
function rowsOf(): Record<string, unknown>[] {
  return [
    { role: 'user', content: '帮我检查一下这两个文件。', key: 'msg_q1' },
    {
      role: 'assistant',
      key: 'msg_a1',
      content: '结论：两个文件都没问题，可以继续。',
      rounds: ROUNDS,
      toolRuns: [{ id: 't1', name: 'read_file', ok: true, output: 'ok' }],
      execId: 'req_exec1',
      execTaskId: 'task_1',
      verdict: 'partial',
    },
  ]
}

describe('执行身份 / ⑤ 磁盘往返', () => {
  it('★★★ 走完整读路径：execId 与 verdict 都要回来（真机只回来一半）', () => {
    const collapsed = collapseByKey(rowsOf())
    const grouped = groupAnswers(collapsed)
    const ui = storedToUi(grouped[1] as never, 't1')
    expect(ui.execId, 'execId 在读回时丢了').toBe('req_exec1')
    expect(ui.verdict, 'verdict 在读回时丢了').toBe('partial')
  })

  it('★★ 任务归属也是同一批字段，不能只带一个', () => {
    const ui = storedToUi(collapseByKey(rowsOf())[1] as never, 't1')
    expect(ui.execTaskId).toBe('task_1')
  })

  it('★★ 一条回复只有 verdict 没有 execId（老记录）→ 不编造执行身份', () => {
    const rows = rowsOf()
    delete (rows[1] as Record<string, unknown>).execId
    const ui = storedToUi(collapseByKey(rows)[1] as never, 't1')
    expect(ui.execId).toBeUndefined()
    expect(ui.verdict).toBe('partial')
  })

  it('★★ 一条回复只有 execId 没有 verdict（暂停 / 轮数用尽）→ 不编造验收结论', () => {
    const rows = rowsOf()
    delete (rows[1] as Record<string, unknown>).verdict
    const ui = storedToUi(collapseByKey(rows)[1] as never, 't1')
    expect(ui.execId).toBe('req_exec1')
    expect(ui.verdict).toBeUndefined()
  })

  it('★★★ 真的写一个 JSONL 再读回来（不只手搓对象）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
    const file = join(dir, 'sess_x.jsonl')
    try {
      const lines = rowsOf().map((row) => JSON.stringify(row))
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
      const parsed = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const ui = storedToUi(collapseByKey(parsed)[1] as never, 't1')
      expect(ui.execId).toBe('req_exec1')
      expect(ui.verdict).toBe('partial')
      expect(ui.rounds).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
