import type { SubagentStep, SubagentTrace, ToolRunRecord } from '@/types'
import { summarizeArgs } from './parseToolOutput'

/* ══════════════════════════════════════════════════════════════
   子代理 v1：把 `subagent.step` 落到那次调用的记录上

   抽出来是因为 `streamEvents.ts` 一直贴着 300 行（硬约束 #2）——
   和 `toolProgress.ts` / `noticeEvents.ts` 同一个理由。

   ⚠️ 这是个**纯函数**（就地改 `runs`），调用方负责把新数组交给 state：
       if (applySubagentEvent(state.toolRuns, event)) state.patch({ toolRuns: [...state.toolRuns] })

   ★ 归位靠 `toolCallId` —— 那是**父侧那次 `spawn_subagent` 调用**的 id
     （内核在 `tool-run-ctx.cjs` 里给贴上的，子代理自己不知道这个 id）。
     找不到那条记录就返回 false，**不猜、不新建** —— 新建等于在对话里凭空
     多一条谁也没调过的工具。
   ══════════════════════════════════════════════════════════════ */

function traceOf(event: Record<string, unknown>, current?: SubagentTrace): SubagentTrace {
  if (current) return current
  return { taskId: String(event.subagentTaskId ?? ''), goal: '', status: 'running', steps: [] }
}

/** `started → completed` 是同一行的两态：能配上就就地替换，配不上才追加 */
function mergeStep(steps: SubagentStep[], step: SubagentStep): SubagentStep[] {
  if (step.phase === 'started') return [...steps, step]
  const at = steps.findIndex((item) => item.id === step.id && item.phase === 'started')
  if (at < 0) return [...steps, step]
  const next = [...steps]
  next[at] = step
  return next
}

/** 一步说成一行（和工具行共用 `summarizeArgs` —— 不在渲染层另编一套） */
export function stepLabel(step: SubagentStep): string {
  const summary = summarizeArgs(step.tool, step.args ?? {})
  return summary ? `${step.tool} ${summary}` : step.tool
}

/** 返回值：找到了那条记录并写进去了（false = 这条不认识，调用方别白重渲） */
export function applySubagentEvent(runs: ToolRunRecord[], event: Record<string, unknown>): boolean {
  const id = String(event.toolCallId ?? '')
  const index = runs.findIndex((run) => run.id === id)
  const current = runs[index]
  if (index < 0 || !current) return false

  const trace = traceOf(event, current.subagent)
  const kind = String(event.kind ?? '')

  if (kind === 'start') {
    runs[index] = {
      ...current,
      subagent: { ...trace, goal: String(event.goal ?? ''), status: 'running' },
    }
    return true
  }

  if (kind === 'step') {
    const raw = event.step as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') return false
    const step: SubagentStep = {
      id: String(raw.id ?? ''),
      at: typeof raw.at === 'number' ? raw.at : Date.now(),
      tool: String(raw.tool ?? ''),
      args: (raw.args ?? {}) as Record<string, unknown>,
      ok: raw.ok !== false,
      ms: typeof raw.ms === 'number' ? raw.ms : undefined,
      phase: raw.phase === 'started' ? 'started' : raw.phase === 'failed' ? 'failed' : 'completed',
    }
    runs[index] = { ...current, subagent: { ...trace, steps: mergeStep(trace.steps, step) } }
    return true
  }

  if (kind === 'done') {
    runs[index] = {
      ...current,
      subagent: {
        ...trace,
        status: event.status === 'failed' ? 'failed' : 'completed',
        turns: typeof event.turns === 'number' ? event.turns : undefined,
      },
    }
    return true
  }

  return false
}
