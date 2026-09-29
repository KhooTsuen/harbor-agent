import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { AGENT_ACTIONS, runningOf, verbOf, toolLabel } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { formatMs, ToolRunRow } from '../ToolRuns'

/* ══════════════════════════════════════════════════════════════
   工具调用**一行说完**（VS Code 那种）

   2026-09-30 用户拿 VS Code 的截图对比后要求的：
     「Checked terminal output and searched for regex patterns」
   一行小字说清干了什么，和正文自然交错 —— 而不是一张带边框的卡片。

   所以这里**不做卡片**（无边框、无背景、无标题行），只给一行摘要 + 可展开的明细。
   原来的 `<ToolRunList>`（卡片式，带「已完成工具调用 · N 步」）仍然留给
   老记录的三段式排版用 —— 那条路不能变。
   ══════════════════════════════════════════════════════════════ */

/** 把这一轮的工具捏成一句话：单步说参数，多步按动作归类计数 */
export function describeRuns(runs: readonly ToolRunRecord[]): string {
  if (runs.length === 0) return ''
  if (runs.length === 1) {
    const one = runs[0]
    const arg = String(one.summary ?? '').trim()
    /* 单步：动词 + 对象最有信息量（「读取 README.md」远胜「读取 1 个文件」） */
    if (arg) return `${verbOf(one.name)} ${arg.length > 48 ? `${arg.slice(0, 48)}…` : arg}`
    return toolLabel(one.name)
  }

  /* 多步：同动作合并计数（「读取 2 个文件、运行 1 条命令」），最多列 3 类 */
  const buckets: Array<{ verb: string; unit: string; n: number }> = []
  for (const run of runs) {
    const [verb, unit] = AGENT_ACTIONS[run.name] ?? [run.name, '次']
    const hit = buckets.find((b) => b.verb === verb && b.unit === unit)
    if (hit) hit.n += 1
    else buckets.push({ verb, unit, n: 1 })
  }
  const head = buckets.slice(0, 3).map((b) => `${b.verb} ${b.n} ${b.unit}`)
  const rest = buckets.length - head.length
  return head.join('、') + (rest > 0 ? ` 等 ${buckets.length} 类` : '')
}

export function ToolLine({ runs }: { runs: ToolRunRecord[] }) {
  const [open, setOpen] = useState(false)
  if (runs.length === 0) return null

  const running = runningOf(runs)
  const failed = runs.some((run) => !run.ok && run.ms !== undefined)
  const totalMs = runs.reduce((sum, run) => sum + (run.ms ?? 0), 0)

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-2xs text-fg-secondary transition-colors duration-fast hover:text-fg-primary"
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        ) : failed ? (
          <XCircle size={11} className="shrink-0" style={{ color: colorOf('failed') }} />
        ) : open ? (
          <ChevronDown size={11} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-fg-tertiary" />
        )}
        <span className="min-w-0 truncate">{describeRuns(runs)}</span>
        {totalMs > 0 ? (
          <span className="shrink-0 font-mono text-fg-tertiary">· {formatMs(totalMs)}</span>
        ) : null}
      </button>

      {open ? (
        <div
          className="mt-1 flex flex-col gap-1 border-l-2 pl-3"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {runs.map((run) => (
            <ToolRunRow key={run.id} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
