import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   过程可见性

   这两块是「参考实现那种感觉」的关键：
     · 思考（reasoning）—— 默认折叠，点开才看
     · 工具调用 —— 一行一个，跑完显示耗时，失败标红

   默认只显示汇总，展开后才查看原始调用和输出，避免工具过程刷屏。
   ══════════════════════════════════════════════════════════════ */

/* ── 思考块 ───────────────────────────────────────────────── */

export function ThinkBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {streaming ? '正在思考…' : '思考过程'}
        <span className="font-mono">{text.length} 字</span>
      </button>

      {open ? (
        <div
          className="mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3 text-xs leading-relaxed text-fg-tertiary"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}

/* ── 工具调用列表 ─────────────────────────────────────────── */

export function ToolRunList({ runs }: { runs: readonly ToolRunRecord[] }) {
  const [open, setOpen] = useState(false)
  if (runs.length === 0) return null
  const running = runs.some((run) => run.output === '' && run.ms === undefined)
  const failed = runs.some((run) => !run.ok && run.ms !== undefined)
  const label = running ? '正在执行工具' : failed ? '工具执行失败' : '已完成工具调用'

  return (
    <div className="mb-2 rounded-sm border border-line-subtle bg-bg-base/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-2xs text-fg-secondary hover:bg-bg-hover"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {running ? (
          <Loader2 size={12} className="animate-spin" />
        ) : failed ? (
          <XCircle size={12} style={{ color: 'var(--danger)' }} />
        ) : (
          <CheckCircle2 size={12} style={{ color: 'var(--success)' }} />
        )}
        <span>{label}</span>
        <span className="font-mono text-fg-tertiary">· {runs.length} 个操作</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line-subtle p-1">
          {runs.map((run) => (
            <ToolRunRow key={run.id} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ToolRunRow({ run }: { run: ToolRunRecord }) {
  const [open, setOpen] = useState(false)
  const running = run.output === '' && run.ms === undefined
  const hasOutput = run.output.trim().length > 0

  return (
    <div className="rounded-sm border border-line-subtle bg-bg-base/40">
      <button
        type="button"
        onClick={() => hasOutput && setOpen((v) => !v)}
        aria-expanded={hasOutput ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 text-left text-2xs',
          hasOutput ? 'cursor-pointer hover:bg-bg-hover' : 'cursor-default',
        )}
      >
        {hasOutput ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-fg-tertiary" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-fg-tertiary" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-fg-tertiary" />
        ) : run.ok ? (
          <CheckCircle2 size={12} className="shrink-0" style={{ color: 'var(--success)' }} />
        ) : (
          <XCircle size={12} className="shrink-0" style={{ color: 'var(--danger)' }} />
        )}

        <Terminal size={11} className="shrink-0 text-fg-tertiary" />
        <span className="shrink-0 font-mono text-fg-secondary">{run.name}</span>
        {run.summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-fg-tertiary" title={run.summary}>
            {run.summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {run.ms !== undefined ? (
          <span className="shrink-0 font-mono text-fg-tertiary">{run.ms}ms</span>
        ) : null}
      </button>

      {open && hasOutput ? (
        <pre className="max-h-64 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] text-fg-secondary whitespace-pre-wrap break-all">
          {run.output}
        </pre>
      ) : null}
    </div>
  )
}

/* ── 「已处理 Ns」那种过程行 ──────────────────────────────── */

export function ProcessLine({
  seconds,
  running,
  children,
}: {
  seconds: number
  running: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2 border-b border-line-subtle pb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {running ? '正在处理…' : `已处理 ${seconds}s`}
      </button>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </div>
  )
}
