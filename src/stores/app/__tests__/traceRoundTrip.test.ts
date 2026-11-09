import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { storedToUi } from '../disk'

/* ══════════════════════════════════════════════════════════════
   有序轨迹的**写入 → 读取**闭环（2026-11-09）

   ── 为什么这一组不能只测函数 ────────────────────────────────────
   `traceNodesOf` 自己那 10 项只能证明「给定一条消息，能按顺序读出节点」。
   它证明不了**这个标识真的被写进磁盘、又从磁盘读回消息对象上** ——
   而这个项目已经栽过好几次「存了但读回时不带」（思考过程、图片、clarify、
   execId 都各栽过一次）。

   所以这一组从**磁盘行**开始走真模块：JSON 行 → collapseByKey → storedToUi。
   少走任何一环，都测不出真实读路径漏字段。
   ══════════════════════════════════════════════════════════════ */

const { collapseByKey } = require('../../../../electron/core/session-collapse.cjs') as {
  collapseByKey: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
}

const ROOT = process.cwd()

/** 一条「新格式」的助手记录：rounds 是执行时攒的，带 trace 标识 */
function newRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    key: 'a1',
    content: '正文 B',
    trace: 'ordered-v1',
    execId: 'req_x',
    execTaskId: 'task_x',
    verdict: 'done',
    rounds: [
      { reasoning: '', content: '正文 A', tools: [] },
      { reasoning: '', content: '', tools: [0] },
      { reasoning: '', content: '正文 B', tools: [] },
    ],
    toolRuns: [{ id: 'call_1', name: 'read_file', ok: true, output: 'x' }],
    ...over,
  }
}

describe('有序轨迹 / 写入端确实写了标识', () => {
  it('★★★ replyPersistence 把 trace 放进共用 answer（三个出口都带上）', () => {
    const src = readFileSync(join(ROOT, 'src/stores/thread/replyPersistence.ts'), 'utf8')
    /* 在共用对象里 —— 不是只在某一个出口里补一行；否则快照 / 收尾会不一致 */
    expect(src).toMatch(/const answer = \{[\s\S]*?trace: 'ordered-v1'/)
  })
})

describe('有序轨迹 / 读取端真的消费了它', () => {
  it('★★★ 磁盘行带 trace → 读回消息对象上还有它', () => {
    const rows = collapseByKey([{ role: 'user', content: '问', key: 'q1' }, newRow()])
    const ui = storedToUi(rows[1] as never, 't1')
    expect(ui.trace).toBe('ordered-v1')
  })

  it('★★★ 顺序与身份一起往返：rounds 三轮、execId、execTaskId 都在', () => {
    const rows = collapseByKey([{ role: 'user', content: '问', key: 'q1' }, newRow()])
    const ui = storedToUi(rows[1] as never, 't1')
    expect(ui.rounds?.length).toBe(3)
    expect(ui.execId).toBe('req_x')
    expect(ui.execTaskId).toBe('task_x')
    expect(ui.verdict).toBe('done')
    /* 关键：读回的 rounds 顺序就是写下去的顺序（不是重排成三段） */
    expect(ui.rounds?.map((r) => r.content)).toEqual(['正文 A', '', '正文 B'])
  })

  it('★★★ 老记录（没有 trace）读回后仍然是「没有」—— 不冒充新格式', () => {
    const rows = collapseByKey([
      { role: 'user', content: '问', key: 'q1' },
      {
        role: 'assistant',
        key: 'a1',
        content: '老答复',
        rounds: [{ reasoning: '', content: '老答复', tools: [] }],
      },
    ])
    const ui = storedToUi(rows[1] as never, 't1')
    expect(ui.trace).toBeUndefined()
  })

  it('★★ 分段快照先落、收尾那条后落 → 收敛后仍带 trace', () => {
    const rows = collapseByKey([
      { role: 'user', content: '问', key: 'q1' },
      newRow({ partial: true, content: '正文 A' }),
      newRow(),
    ])
    const ui = storedToUi(rows[1] as never, 't1')
    expect(ui.trace).toBe('ordered-v1')
    expect(ui.rounds?.length).toBe(3)
  })
})
