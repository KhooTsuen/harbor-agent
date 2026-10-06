import { useState } from 'react'
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { SubagentStep, SubagentTrace } from '@/types'
import { stepLabel } from '@/stores/thread/subagentEvents'
import { colorOf } from '@/lib/statusLanguage'
import { cn } from '@/lib/utils'
import { formatMs } from './ToolRuns'
import { useScrollGuard } from './scrollGuard'

/* ══════════════════════════════════════════════════════════════
   子代理卡片（v1）

   为什么单开一张卡，而不是并进工具行：子代理的**意义**是「父上下文里不留原文」，
   可用户仍然要看得见它读了什么、跑到哪一步。工具行（`message/ToolLine.tsx`）
   只有一行摘要、还折着 —— 而子代理正在跑的时候，恰恰是最该看见它的时候。

   视觉跟「执行计划」卡（`PlanCard.tsx`）对齐。理由只有一条：同一份对话里两张卡
   长得不一样，接缝一眼可见 —— 2026-09-30 拆掉那套旧工具卡片的同一条教训。

   ★ 卡片里**不显示**子代理读到的内容，只显示「它读了哪个文件、成没成」：
     原文既不该进父上下文，也不该进落盘（见 `SubagentStep` 的注释）。
   ══════════════════════════════════════════════════════════════ */

/** 一步最多摊开多少条 —— 长任务别把对话铺满（和 ToolLine 一个道理） */
const MAX_VISIBLE_STEPS = 40

/** 一步的状态点：转圈（正在跑）/ ✗（失败）/ ✓（成了） */
function StepDot({ step }: { step: SubagentStep }) {
  if (step.phase === 'started') {
    return <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-accent" />
  }
  if (!step.ok || step.phase === 'failed') {
    return <XCircle size={12} className="mt-0.5 shrink-0" style={{ color: colorOf('failed') }} />
  }
  return (
    <CheckCircle2 size={12} className="mt-0.5 shrink-0" style={{ color: colorOf('completed') }} />
  )
}

export function SubagentCard({ trace }: { trace: SubagentTrace }) {
  /* 默认**展开** —— 子代理是「上下文隔离」的，用户能看到的就只剩这张卡了 */
  const [open, setOpen] = useState(true)
  const guard = useScrollGuard()

  const running = trace.status === 'running'
  const finished = trace.steps.filter((step) => step.phase !== 'started').length
  const totalMs = trace.steps.reduce((sum, step) => sum + (step.ms ?? 0), 0)
  /* 上限截的是**最早**的：最近几步才是当前关心的（和会话只渲染最近若干条同理） */
  const hidden = Math.max(0, trace.steps.length - MAX_VISIBLE_STEPS)
  const shown = hidden > 0 ? trace.steps.slice(-MAX_VISIBLE_STEPS) : trace.steps

  return (
    <div className="mt-1 rounded-sm border border-line-hairline bg-bg-raised/40 px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value)
          guard?.enterFree()
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        <Bot size={12} className="shrink-0 text-fg-tertiary" />
        <span className="text-2xs text-fg-secondary">
          只读子代理 · {running ? '进行中' : trace.status === 'failed' ? '失败' : '已完成'}
          {trace.steps.length > 0 ? ` · ${finished}/${trace.steps.length} 步` : ''}
          {trace.turns ? ` · ${trace.turns} 轮` : ''}
          {totalMs > 0 ? ` · ${formatMs(totalMs)}` : ''}
        </span>
        {running ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" /> : null}
      </button>

      {open ? (
        <>
          {trace.goal ? (
            <p className="mt-1 line-clamp-2 text-2xs text-fg-tertiary" title={trace.goal}>
              {trace.goal}
            </p>
          ) : null}

          {shown.length > 0 ? (
            <div className="mt-1 flex flex-col gap-0.5">
              {hidden > 0 ? (
                <p className="text-2xs text-fg-tertiary">
                  只显示最近 {MAX_VISIBLE_STEPS} 步，更早的 {hidden} 步没摊开
                </p>
              ) : null}
              {shown.map((step) => (
                <div key={`${step.id}-${step.at}`} className="flex items-start gap-1.5 text-2xs">
                  <StepDot step={step} />
                  <span
                    className={cn(
                      'min-w-0 break-all',
                      step.phase === 'started' ? 'text-fg-primary' : 'text-fg-secondary',
                    )}
                  >
                    {stepLabel(step)}
                  </span>
                  {step.ms !== undefined ? (
                    <span className="shrink-0 font-mono text-fg-tertiary">{step.ms}ms</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-2xs text-fg-tertiary">
              {running ? '子代理已派出，还没开始调工具…' : '这次没调工具'}
            </p>
          )}

          {trace.taskId ? (
            <p className="mt-1 font-mono text-2xs text-fg-tertiary">台账：{trace.taskId}</p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
