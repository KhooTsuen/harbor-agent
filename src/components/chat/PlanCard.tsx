import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ListChecks } from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   执行计划（AG-004）

   文档把执行管线定成 Understand → Plan → Execute → Verify → Respond，
   要求「Plan 与 Execute 分离」：计划要能**单独看见**，而不是混在模型的
   正文里（以前 ` ```plan ` 块被 markdown 当普通代码块渲染，看完就滚过去了，
   想回头对照「现在做到哪一步了」只能往上翻）。

   另外两条是这次一起做的：

     · **更新保留历史** —— 计划改过几版、每版为什么改都留得下来
       （内核 `task-plan.cjs` 的 `recordVersion` 在记，这里只管显示）；

     · **Re-plan** —— 用户改了要求、或者模型发现路走不通，重新规划之后
       这里显示的是新版，旧版折在「历史」里。以前内核用一个布尔量
       「只抓第一次」，重新规划会被静默丢弃，界面永远停在第一版。

   勾选状态来自计划条目自身的 `[x]` / `[ ]` 标记 —— 由模型维护，
   内核按它算完成度（`task-context.cjs` 的 `progressOf`），这里只是照着画。

   AG-027 给步骤补上三态：✓ 已完成 / **● 当前**（第一条没勾掉的）/ ○ 待办。
   两态看不出「现在在做哪条」，只能看出还剩几条。
   ══════════════════════════════════════════════════════════════ */

export interface PlanVersion {
  plan: string[]
  at: number
  reason: string
}

/** 条目开头的 `[x]` / `[X]` 算做完；其余一律当作没做（和内核 isDone 同口径） */
export function isDone(step: string): boolean {
  return /^\s*\[[xX]\]/.test(step)
}

export function textOf(step: string): string {
  return step.replace(/^\s*\[[ xX]\]\s*/, '').trim()
}

/**
 * 「现在轮到哪一步」= 第一条没勾掉的步骤的下标；全做完了返回 -1。
 *
 * 单独抽出来是因为它**不是「第一条 □」那么简单**：模型有可能把 `[ ]` 写在
 * 后面几条上（先勾了第 3 条才发现第 2 条漏了），所以只能从头扫第一条没勾的。
 * 抽出来还有个好处：能单独测（组件里这段代码没法直接断言）。
 */
export function currentStepIndex(plan: readonly string[]): number {
  return plan.findIndex((step) => !isDone(step))
}

function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function PlanSteps({ plan, markCurrent = false }: { plan: string[]; markCurrent?: boolean }) {
  /* 「当前」= 第一条没勾掉的。历史版本不标（旧版没有「现在」可言） */
  const currentIndex = markCurrent ? currentStepIndex(plan) : -1
  return (
    <ol className="flex flex-col gap-0.5">
      {plan.map((step, index) => {
        const done = isDone(step)
        const current = index === currentIndex
        return (
          <li
            key={`${index}-${step}`}
            className="flex items-start gap-1.5 text-2xs"
            aria-current={current ? 'step' : undefined}
          >
            {done ? (
              <CheckCircle2
                size={12}
                className="mt-0.5 shrink-0"
                style={{ color: 'var(--success)' }}
              />
            ) : (
              <Circle
                size={12}
                className="mt-0.5 shrink-0"
                /* AG-027：轮到的那条画实心 ●，其余 ○ —— 否则看得出剩几步，看不出在做哪步 */
                style={current ? { color: 'var(--accent-blue)', fill: 'currentColor' } : undefined}
              />
            )}
            <span
              className={cn(
                done && 'text-fg-tertiary line-through',
                !done && !current && 'text-fg-secondary',
                current && 'font-medium text-fg-primary',
              )}
            >
              {index + 1}. {textOf(step)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function PlanCard({ versions }: { versions: PlanVersion[] }) {
  const [showHistory, setShowHistory] = useState(false)

  if (versions.length === 0) return null
  const current = versions[versions.length - 1]
  const older = versions.slice(0, -1)
  const doneCount = current.plan.filter(isDone).length

  return (
    <div className="mt-1 rounded-sm border border-line-hairline bg-bg-raised/40 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <ListChecks size={12} className="shrink-0 text-fg-tertiary" />
        <span className="text-2xs text-fg-secondary">
          执行计划 · {doneCount}/{current.plan.length} 步
          {versions.length > 1 ? ` · 第 ${versions.length} 版` : ''}
        </span>
      </div>

      <div className="mt-1">
        <PlanSteps plan={current.plan} markCurrent />
      </div>

      {older.length > 0 ? (
        <div className="mt-1">
          <button
            type="button"
            className="flex items-center gap-1 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            计划历史（{older.length} 版）
          </button>

          {showHistory ? (
            <div className="mt-1 flex flex-col gap-1.5 border-l border-line-hairline pl-2">
              {older.map((version, index) => (
                <div key={`${version.at}-${index}`}>
                  <p className="text-2xs text-fg-tertiary">
                    第 {index + 1} 版 · {version.reason || '计划更新'} · {clockOf(version.at)}
                  </p>
                  <div className="mt-0.5 opacity-60">
                    <PlanSteps plan={version.plan} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
