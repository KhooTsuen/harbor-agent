import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, ToolRunRecord } from '@/types'
import { SessionLineSchema } from '@/lib/schemas'
import { useAuditStore } from '@/stores/useAuditStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { applySubagentEvent, stepLabel } from '../subagentEvents'
import { handleStreamEvent, type StreamState } from '../streamEvents'

/* ══════════════════════════════════════════════════════════════
   子代理 v1：界面卡片的数据链

   这个功能最容易坏的地方不是「画得好不好看」，是**事件归位** ——
   内核发的事件要正好落回「派子代理」那一次工具调用上。归位错了，
   界面要么长出一张谁也认不出来的卡、要么干脆什么都不显示；
   而这四种毛病（形状对不上 / id 对不上 / 静默丢弃）单测都照不出来，
   只有真跑才现形（AGENT.md 第 9 条）。所以这里两头都钉：
   纯逻辑测行为，**源码守卫**钉内核那一侧的字段名与事件名。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..', '..')

function record(overrides: Partial<ToolRunRecord> = {}): ToolRunRecord {
  return { id: 'call_1', name: 'spawn_subagent', ok: true, output: '', ...overrides }
}

function stepEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'subagent.step',
    toolCallId: 'call_1',
    subagentTaskId: 'task_child',
    kind: 'step',
    step: {
      id: 'sub_tool_1',
      at: 1,
      tool: 'read_file',
      args: { path: 'docs/README.md' },
      ok: true,
      ms: 9,
      phase: 'started',
    },
    ...over,
  }
}

describe('子代理事件 / 归位', () => {
  it('start 落到那条调用上：记下 goal 与 running', () => {
    const runs = [record()]
    expect(
      applySubagentEvent(runs, {
        toolCallId: 'call_1',
        subagentTaskId: 't1',
        kind: 'start',
        goal: '读 5 份',
      }),
    ).toBe(true)
    expect(runs[0].subagent).toMatchObject({ taskId: 't1', goal: '读 5 份', status: 'running' })
  })

  it('★ toolCallId 对不上 → 返回 false，**不新建**记录', () => {
    const runs = [record()]
    expect(applySubagentEvent(runs, stepEvent({ toolCallId: 'call_nope' }))).toBe(false)
    expect(runs).toHaveLength(1)
    expect(runs[0].subagent).toBeUndefined()
  })

  it('step(started) 追加一行', () => {
    const runs = [record()]
    applySubagentEvent(runs, stepEvent())
    expect(runs[0].subagent?.steps).toHaveLength(1)
    expect(runs[0].subagent?.steps[0]).toMatchObject({ tool: 'read_file', phase: 'started' })
  })

  it('★ started → completed 是**同一行**：就地替换，不追第二行', () => {
    const runs = [record()]
    applySubagentEvent(runs, stepEvent())
    applySubagentEvent(
      runs,
      stepEvent({
        step: {
          id: 'sub_tool_1',
          at: 2,
          tool: 'read_file',
          args: { path: 'docs/README.md' },
          ok: true,
          ms: 12,
          phase: 'completed',
        },
      }),
    )
    expect(runs[0].subagent?.steps).toHaveLength(1)
    expect(runs[0].subagent?.steps[0]).toMatchObject({ phase: 'completed', ms: 12 })
  })

  it('★ id 对不上的 completed **不误配**前一行（宁可多一行，不许张冠李戴）', () => {
    const runs = [record()]
    applySubagentEvent(runs, stepEvent())
    applySubagentEvent(
      runs,
      stepEvent({
        step: { id: 'other', at: 2, tool: 'read_file', args: {}, ok: true, phase: 'completed' },
      }),
    )
    expect(runs[0].subagent?.steps).toHaveLength(2)
    expect(runs[0].subagent?.steps[0].phase).toBe('started')
  })

  it('done 收尾：写 status 与轮数', () => {
    const runs = [record()]
    applySubagentEvent(runs, {
      toolCallId: 'call_1',
      subagentTaskId: 't1',
      kind: 'done',
      status: 'completed',
      turns: 6,
    })
    expect(runs[0].subagent).toMatchObject({ status: 'completed', turns: 6 })
  })

  it('失败的 done → status=failed', () => {
    const runs = [record()]
    applySubagentEvent(runs, {
      toolCallId: 'call_1',
      subagentTaskId: 't1',
      kind: 'done',
      status: 'failed',
    })
    expect(runs[0].subagent?.status).toBe('failed')
  })

  it('不认识的 kind → false（调用方别白重渲）', () => {
    const runs = [record()]
    expect(applySubagentEvent(runs, { toolCallId: 'call_1', kind: '?' })).toBe(false)
  })

  it('一步说成一行（复用 summarizeArgs，不另编一套）', () => {
    expect(
      stepLabel({
        id: 'x',
        at: 0,
        tool: 'read_file',
        args: { path: 'docs/README.md' },
        ok: true,
        phase: 'completed',
      }),
    ).toBe('read_file docs/README.md')
  })
})

describe('子代理事件 / 接线守卫（跨层形状）', () => {
  it('★ 内核发的事件名与渲染层认的是同一个', () => {
    const kernel = readFileSync(join(SRC, 'electron/core/tool-run-ctx.cjs'), 'utf8')
    const ui = readFileSync(join(SRC, 'src/stores/thread/streamEvents.ts'), 'utf8')
    expect(kernel).toContain("type: 'subagent.step'")
    expect(ui).toContain("case 'subagent.step'")
  })

  it('★ 内核**贴上了父侧那次调用的 toolCallId**（渲染层归位全靠它）', () => {
    const kernel = readFileSync(join(SRC, 'electron/core/tool-run-ctx.cjs'), 'utf8')
    expect(kernel).toMatch(/emit\(\{ type: 'subagent\.step', toolCallId, \.\.\.payload \}\)/)
  })

  it('★ 子代理只转「一次工具调用」那三种（进度/流式增量都不许灌进界面）', () => {
    const src = readFileSync(join(SRC, 'electron/core/subagent.cjs'), 'utf8')
    expect(src).toContain("type !== 'agent.tool.started'")
    expect(src).toContain("type !== 'agent.tool.completed'")
    expect(src).toContain("type !== 'agent.tool.failed'")
    /* 反向锁：别退回成 `startsWith('agent.tool.')` 一把捞（那会把 progress 也算成一步） */
    expect(src).not.toContain("startsWith('agent.tool.')")
    expect(src).toContain('emit: childEmit')
  })

  it('★ 内核发出的 kind 取值，渲染层都认（多一个 = 静默丢弃）', () => {
    const kernel = readFileSync(join(SRC, 'electron/core/subagent.cjs'), 'utf8')
    const ui = readFileSync(join(SRC, 'src/stores/thread/subagentEvents.ts'), 'utf8')
    for (const kind of ['start', 'step', 'done']) {
      expect(kernel).toContain(`kind: '${kind}'`)
      expect(ui).toContain(`kind === '${kind}'`)
    }
  })

  it('★ 卡片接在对话流里（不是只在任务中心）', () => {
    const src = readFileSync(join(SRC, 'src/components/chat/message/ToolLine.tsx'), 'utf8')
    expect(src).toContain('SubagentCard')
    expect(src).toMatch(/run\.subagent \? <SubagentCard/)
  })

  it('★ 事件类型写在 chat-events.ts 里（主进程→渲染层的形状只有这一处）', () => {
    const src = readFileSync(join(SRC, 'src/types/chat-events.ts'), 'utf8')
    expect(src).toContain("type: 'subagent.step'")
  })

  it('★ 类型里**不存子代理读到的原文**（只留 tool + args）', () => {
    const src = readFileSync(join(SRC, 'src/types/conversation.ts'), 'utf8')
    const block = src.slice(src.indexOf('export interface SubagentStep'))
    expect(block).toContain('args: Record<string, unknown>')
    expect(block).not.toContain('output')
    expect(block).not.toContain('result')
  })
})

/* ══════════════════════════════════════════════════════════════
   ★ 真机复现过的坑（2026-10-07）：卡片**留不住** —— 子代理跑时卡片在，
   父侧工具一收尾（`agent.tool.completed`）**整张消失**；重开会话更没有。
   两层断点（各自都对、接起来什么都不发生 — AGENT.md 第 9 条）：
   `streamEvents.ts` 收尾重建了新记录 → 抹掉 `subagent`；
   `schemas.ts` 的 toolRuns 没声明它 → zod 读回来**静静剥掉**。
   ══════════════════════════════════════════════════════════════ */

function makeStreamState(): StreamState {
  return {
    content: '',
    reasoning: '',
    toolRuns: [],
    rounds: [],
    citations: [],
    patch: () => {},
    /* 只有 done 分支会读它 —— 这两条测试不走 done，给个最小壳就够 */
    snapshot: () => ({ id: 'msg_1' }) as Message,
    finish: () => {},
    threadId: 't1',
  }
}

describe('子代理事件 / 卡片留得住（真机复现的那个坑）', () => {
  beforeEach(() => {
    /* completed 分支会顺带刷新任务 / 审计 —— 换成 no-op，测接线不必起整个 store */
    useTaskStore.setState({ refresh: () => Promise.resolve() } as never)
    useAuditStore.setState({ bump: () => {} } as never)
  })

  it('★ 父工具收尾（completed）不抹掉子代理 trace', () => {
    const state = makeStreamState()
    handleStreamEvent(
      { type: 'agent.tool.started', toolCallId: 'call_1', name: 'spawn_subagent' },
      state,
    )
    handleStreamEvent(stepEvent({ kind: 'start', goal: '读 3 份' }), state)
    handleStreamEvent(stepEvent(), state)
    handleStreamEvent(stepEvent({ kind: 'done', status: 'completed', turns: 2 }), state)
    expect(state.toolRuns[0].subagent).toMatchObject({ status: 'completed', turns: 2 })

    handleStreamEvent(
      {
        type: 'agent.tool.completed',
        toolCallId: 'call_1',
        name: 'spawn_subagent',
        result: 'ok',
        ms: 41,
      },
      state,
    )

    /* 该补的补上（ms），trace 必须原样留着 —— 抹掉就等于卡片整张消失 */
    expect(state.toolRuns[0].ms).toBe(41)
    expect(state.toolRuns[0].subagent).toMatchObject({ status: 'completed', goal: '读 3 份' })
    expect(state.toolRuns[0].subagent?.steps).toHaveLength(1)
  })

  it('★ 落盘的 trace 过一遍真 schema 读回来还在（zod 别剥）', () => {
    const line = {
      type: 'message',
      role: 'assistant',
      content: '结论',
      toolRuns: [
        {
          id: 'call_1',
          name: 'spawn_subagent',
          ok: true,
          output: 'ok',
          ms: 41,
          subagent: {
            taskId: 't_child',
            goal: '读 3 份',
            status: 'completed',
            turns: 2,
            steps: [
              {
                id: 's1',
                at: 1,
                tool: 'read_file',
                args: { path: 'docs/README.md' },
                ok: true,
                ms: 9,
                phase: 'completed',
              },
            ],
          },
        },
      ],
    }
    const parsed = SessionLineSchema.safeParse(line)
    if (!parsed.success) throw new Error(`schema 没认这条落盘记录：${parsed.error.message}`)
    const runs = parsed.data.type === 'message' ? parsed.data.toolRuns : undefined
    expect(runs?.[0].subagent?.goal).toBe('读 3 份')
    expect(runs?.[0].subagent?.steps[0].tool).toBe('read_file')
  })
})
