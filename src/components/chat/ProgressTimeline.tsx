import { useState } from 'react'
import type { AgentPhase } from '@/types'
import { isTerminalPhase, phaseLabel } from '@/lib/agentPhase'
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from 'lucide-react'
import { isDone, textOf } from './PlanCard'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   进度时间线（AG-005）

   把「走到哪了」画成一条线。三类行：

     · 阶段行 —— 主进程状态机推过来的相位（✓ 走过 / ● 正在走的那个）
     · 动作行 —— 真实发生过的工具调用（✓ 成功 / ✗ 失败，失败带原因）
     · 待办行 —— 计划里还没勾掉的步骤（○）

   三件**不做**的事（都是有意为之）：

     1. **不显示思考过程**。要求里写了「不展示无意义的内部思考内容」，
        思维链是给人看推理用的，放时间线里只会把真正的进度淹掉。
     2. **不猜「哪个工具对应哪条计划」**。内核里没有这个映射，
        按顺序硬配就是编 —— 时间线宁可两段分开列，也不编一个对不上的对应关系。
     3. **不显示还没到的相位**。相位顺序的真相源是内核的转移表，
        前端再硬编一份「准备→规划→执行→验证→回复」就是第二份要维护的真相
        （而实际跑起来 `executing` 会来回反复，硬编的顺序其实是错的）。
   ══════════════════════════════════════════════════════════════ */

export interface TimelineStep {
  at: number
  tool: string
  ok: boolean
  ms: number
  summary: string
}

/** 工具输出的第一行、压掉空白、截断 —— 时间线一行只放一句话 */
export function firstLine(text: string, max = 72): string {
  const line = String(text ?? '')
    .split('\n')
    .find((item) => item.trim())
  const flat = (line ?? '').trim().replace(/\s+/g, ' ')
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 一行一个状态点 */
function Dot({ state }: { state: 'done' | 'active' | 'todo' | 'failed' }) {
  if (state === 'active') {
    return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
  }
  if (state === 'failed') return <XCircle size={13} className="shrink-0 text-[var(--danger)]" />
  if (state === 'done') return <CheckCircle2 size={13} className="shrink-0 text-[var(--success)]" />
  return <Circle size={13} className="shrink-0 text-fg-tertiary" />
}

const DOT_TEXT: Record<'done' | 'active' | 'todo' | 'failed', string> = {
  done: 'text-fg-secondary',
  active: 'font-medium text-fg-primary',
  todo: 'text-fg-tertiary',
  failed: 'text-[var(--danger)]',
}

/** 默认只显示最近几条动作，不然一个长任务能把面板铺满 */
const VISIBLE_STEPS = 5

interface ProgressTimelineProps {
  /** 走过的相位（相邻去重，事件驱动） */
  phases: readonly AgentPhase[]
  /** 任务台账里的工具调用记录 */
  steps: readonly TimelineStep[]
  /** 最新一版计划（用来画 ○ 待办行） */
  plan: readonly string[]
}

export function ProgressTimeline({ phases, steps, plan }: ProgressTimelineProps) {
  const [expanded, setExpanded] = useState(false)

  const hidden = Math.max(0, steps.length - VISIBLE_STEPS)
  const visible = expanded || hidden === 0 ? steps : steps.slice(-VISIBLE_STEPS)
  const todo = plan.filter((item) => !isDone(item))
  if (phases.length === 0 && steps.length === 0 && todo.length === 0) return null

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="mb-0.5 text-[11px] font-medium tracking-wide text-fg-tertiary">执行进度</div>

      {/* ── 阶段行：走过的 + 正在走的 ── */}
      {phases.map((phase, index) => {
        const last = index === phases.length - 1
        const state = !last || isTerminalPhase(phase) ? 'done' : 'active'
        return (
          <div key={`${phase}-${index}`} className="flex items-center gap-2">
            <Dot state={state} />
            {/*
              `phaseLabel` 给的是进行时（「正在准备任务」），放在 ✓ 那行读着别扭
              （文档里的写法是「✓ 分析任务」）。去掉前缀即可，不改 phaseLabel 本身
              —— 它在别处（占位文案）就是该用进行时的。
            */}
            <span className={DOT_TEXT[state]}>
              {(phaseLabel(phase) || phase).replace(/^正在/, '')}
            </span>
          </div>
        )
      })}

      {/* ── 动作行：真跑过的工具 ── */}
      {hidden > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-2 text-left text-fg-tertiary hover:text-fg-secondary"
        >
          <ChevronRight size={13} className="shrink-0" />
          <span>展开更早的 {hidden} 步</span>
        </button>
      )}
      {expanded && hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-2 text-left text-fg-tertiary hover:text-fg-secondary"
        >
          <ChevronDown size={13} className="shrink-0" />
          <span>收起</span>
        </button>
      )}
      {visible.map((step, index) => {
        const state = step.ok ? 'done' : 'failed'
        const detail = firstLine(step.summary)
        return (
          <div key={`${step.at}-${index}`} className="flex items-start gap-2">
            <span className="mt-0.5">
              <Dot state={state} />
            </span>
            <span className={cn('min-w-0', DOT_TEXT[state])}>
              <span className="font-mono">{step.tool}</span>
              {/* 失败的那行把原因摆出来（要求里写了「失败步骤保留原因」） */}
              {detail && (
                <span className={cn('ml-1.5', step.ok ? 'text-fg-tertiary' : '')}>
                  {step.ok ? detail : `失败：${detail}`}
                </span>
              )}
            </span>
          </div>
        )
      })}

      {/* ── 待办行：计划里还没勾掉的 ── */}
      {todo.map((item) => (
        <div key={item} className="flex items-center gap-2">
          <Dot state="todo" />
          <span className="text-fg-tertiary">{textOf(item)}</span>
        </div>
      ))}
    </div>
  )
}
