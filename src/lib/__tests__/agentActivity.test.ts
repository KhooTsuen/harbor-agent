import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_ACTIONS, activityLabel, runningOf, verbOf } from '../agentActivity'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   AG-008：消除无意义等待

   要防的退化是**退回一句「正在处理…」**（或者干脆是 Thinking...）。
   所以这里测三件事：

     · 有工具在跑就说工具（带参数），没工具才退回相位
     · 「还在跑」的判据和 ToolRuns.tsx 一致
     · **接线守卫** —— 三个显示位置有没有真的用上它、旧文案有没有被改回来
   ══════════════════════════════════════════════════════════════ */

const run = (over: Partial<ToolRunRecord>): ToolRunRecord => ({
  id: 'r1',
  name: 'read_file',
  ok: true,
  output: '',
  ...over,
})

const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('AG-008 / verbOf', () => {
  it('收录过的工具给动作词', () => {
    expect(verbOf('read_file')).toBe('读取')
    expect(verbOf('run_shell')).toBe('运行')
    expect(verbOf('search_web')).toBe('搜索')
  })

  it('没收录的工具老实给原名（不编）', () => {
    expect(verbOf('some_new_tool')).toBe('some_new_tool')
  })

  it('动作词表就是 AGENT_ACTIONS 的第一列', () => {
    for (const [name, pair] of Object.entries(AGENT_ACTIONS)) {
      expect(verbOf(name)).toBe(pair[0])
    }
  })
})

describe('AG-008 / runningOf', () => {
  it('空列表没有正在跑的', () => {
    expect(runningOf([])).toBeUndefined()
  })

  it('跑完的（有 ms / 有输出）不算正在跑', () => {
    expect(runningOf([run({ output: 'done', ms: 12 })])).toBeUndefined()
    expect(runningOf([run({ output: 'done' })])).toBeUndefined()
    expect(runningOf([run({ ms: 12 })])).toBeUndefined()
  })

  it('没有输出也没有耗时的就是正在跑', () => {
    expect(runningOf([run({})])?.id).toBe('r1')
  })

  it('多条时给第一条正在跑的', () => {
    const a = run({ id: 'a', output: 'x', ms: 3 })
    const b = run({ id: 'b' })
    const c = run({ id: 'c' })
    expect(runningOf([a, b, c])?.id).toBe('b')
  })
})

describe('AG-008 / activityLabel', () => {
  it('有工具在跑就说工具 + 参数（比相位具体）', () => {
    expect(activityLabel([run({ name: 'read_file', summary: 'cmd/main.gd' })])).toBe(
      '正在读取 cmd/main.gd',
    )
  })

  it('工具在跑但没参数摘要，就只说动作', () => {
    expect(activityLabel([run({ name: 'run_shell' })])).toBe('正在运行')
  })

  it('参数摘要是空白的，也退回只说动作', () => {
    expect(activityLabel([run({ name: 'read_file', summary: '   ' })])).toBe('正在读取')
  })

  it('★ 工具优先于相位 —— 就算相位说「正在执行」，也要说清在干什么', () => {
    const runs = [run({ name: 'edit_file', summary: 'src/main.ts' })]
    expect(activityLabel(runs, 'executing')).toBe('正在修改 src/main.ts')
  })

  it('没有工具在跑就退回相位文案', () => {
    expect(activityLabel([], 'thinking')).toBe('正在分析任务')
    expect(activityLabel([run({ output: 'ok', ms: 5 })], 'thinking')).toBe('正在分析任务')
  })

  it('相位也没有就给一句通用兜底（不是空字符串）', () => {
    expect(activityLabel([])).toBe('正在处理…')
    expect(activityLabel([], undefined)).toBe('正在处理…')
  })

  it('没收录的工具在跑，动作词就用原名', () => {
    expect(activityLabel([run({ name: 'frobnicate', summary: 'x' })])).toBe('正在frobnicate x')
  })
})

describe('AG-008 / 接线守卫', () => {
  it('消息占位用 activityLabel（断言完整表达式，不是关键词）', () => {
    const src = read('src/components/chat/MessageItem.tsx')
    expect(src).toContain('activityLabel(message.toolRuns ?? [], message.phase)')
    expect(src).not.toContain("phaseLabel(message.phase) || '正在处理…'")
  })

  it('顶栏显示活动，且取自最后一条助手消息（不是 at(-1)）', () => {
    const src = read('src/components/layout/AppTitleBar.tsx')
    expect(src).toContain('activityLabel(lastAssistant?.toolRuns ?? [], thread?.phase)')
    expect(src).toContain(
      "const lastAssistant = [...(thread?.messages ?? [])].reverse().find((m) => m.role === 'assistant')",
    )
  })

  it('工具概览行说清是哪个工具，不再是一句「正在执行工具」', () => {
    const src = read('src/components/chat/ToolRuns.tsx')
    expect(src).not.toContain("'正在执行工具'")
    expect(src).toContain('const active = runningOf(runs)')
    expect(src).toContain('`正在${verbOf(active.name)}…`')
  })

  it('动作词表只有一份（ToolRuns 从 lib 拿，不自己再定义）', () => {
    const src = read('src/components/chat/ToolRuns.tsx')
    expect(src).not.toContain('export const ACTIONS')
    expect(src).toContain(
      "import { AGENT_ACTIONS as ACTIONS, runningOf, verbOf } from '@/lib/agentActivity'",
    )
  })

  it('死代码 ProcessLine 已删（全仓无调用）', () => {
    expect(read('src/components/chat/ToolRuns.tsx')).not.toContain('ProcessLine')
  })
})
