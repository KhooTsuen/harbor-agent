import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import { traceNodesOf, traceSignatureOf } from '../traceNodes'

/* ══════════════════════════════════════════════════════════════
   执行轨迹的读取端（2026-11-09）

   ── 为什么这一组必须存在 ────────────────────────────────────────
   上一轮已经让 `rounds` 双向落盘了，但**没有任何一处按顺序把它们读出来**：
   显示分开取（正文块 + 折叠区）、复制只取正文、导出又走一条路。
   三处各遍历各的，顺序对不对没法验证，也没法拿来做「重启前后是否同一条轨迹」的对比。

   `traceNodesOf` 是那个单一入口。这一组钉三件会漂的事：
     ① 顺序与 `rounds` 数组一致（不重排、不合并）
     ② 工具用 `toolCallId`（`run.id`）认身份，不按名字或下标猜
     ③ `ordered` 只认 `trace === 'ordered-v1'` —— 老记录**不许**被当成真实轨迹
   ══════════════════════════════════════════════════════════════ */

function msgOf(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    status: 'sent',
    kind: 'text',
    ...over,
  } as Message
}

describe('轨迹读取 / ① 顺序就是 rounds 的顺序', () => {
  it('★★★ 正文 A → 工具 → 正文 B 还原成 body>tool>body', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [
        { reasoning: '', content: '正文 A', tools: [] },
        { reasoning: '', content: '', tools: [0] },
        { reasoning: '', content: '正文 B', tools: [] },
      ],
      toolRuns: [{ id: 'call_1', name: 'read_file', ok: true, output: 'ok' }],
    })
    expect(traceSignatureOf(m)).toBe('body>tool>body')
  })

  it('★★★ 三层顺序原样保留，不合并、不重排', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [
        { reasoning: '想一', content: '答一', tools: [0] },
        { reasoning: '想二', content: '答二', tools: [1] },
      ],
      toolRuns: [
        { id: 'c1', name: 'a', ok: true, output: '' },
        { id: 'c2', name: 'b', ok: true, output: '' },
      ],
    })
    const nodes = traceNodesOf(m).nodes
    expect(nodes.map((n) => `${n.round}:${n.kind}`)).toEqual([
      '0:reasoning',
      '0:body',
      '0:tool',
      '1:reasoning',
      '1:body',
      '1:tool',
    ])
  })

  it('★★ 空轮不产出节点（不编占位）', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [{ reasoning: '', content: '', tools: [] }],
      toolRuns: [],
    })
    expect(traceNodesOf(m).nodes).toEqual([])
  })
})

describe('轨迹读取 / ② 工具身份与状态', () => {
  it('★★★ 工具节点带 toolCallId 与 pending，不按名字猜', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [{ reasoning: '', content: '', tools: [0] }],
      toolRuns: [{ id: 'call_x9', name: 'exec', ok: true, output: '', pending: true }],
    })
    const node = traceNodesOf(m).nodes[0]
    expect(node).toMatchObject({ kind: 'tool', id: 'call_x9', pending: true })
  })

  it('★★★ pending 的工具签名带问号（重启后一眼看出结果未确认）', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [{ reasoning: '', content: '', tools: [0] }],
      toolRuns: [{ id: 'c1', name: 'exec', ok: true, output: '', pending: true }],
    })
    expect(traceSignatureOf(m)).toBe('tool?')
  })

  it('★★ 下标越界就跳过，不编一条假的工具出来', () => {
    const m = msgOf({
      trace: 'ordered-v1',
      rounds: [{ reasoning: '', content: '答', tools: [3] }],
      toolRuns: [],
    })
    expect(traceSignatureOf(m)).toBe('body')
  })
})

describe('轨迹读取 / ③ ordered 只认新格式', () => {
  it('★★★ 带 trace=ordered-v1 → ordered 为 true', () => {
    const m = msgOf({ trace: 'ordered-v1', rounds: [{ reasoning: '', content: 'a', tools: [] }] })
    expect(traceNodesOf(m).ordered).toBe(true)
  })

  it('★★★ 老记录（没有 trace）→ ordered 为 false，哪怕它有 rounds', () => {
    const m = msgOf({ rounds: [{ reasoning: '', content: 'a', tools: [] }] })
    expect(traceNodesOf(m).ordered).toBe(false)
  })

  it('★★★ 老记录没有 rounds（读侧会合成一轮）→ 仍然是 false', () => {
    const m = msgOf({ content: '老答复', reasoning: '老思考' })
    const view = traceNodesOf(m)
    expect(view.ordered).toBe(false)
    /* 兼容路径照样给节点，只是不标成「真实轨迹」 */
    expect(view.nodes.length).toBeGreaterThan(0)
  })

  it('★★ 用户消息只有一段正文，没有工具节点', () => {
    const m = msgOf({ role: 'user', content: '我说的话' })
    expect(traceNodesOf(m).nodes).toEqual([{ kind: 'body', round: 0, text: '我说的话' }])
  })
})
