import { useState } from 'react'
import { extractImageUrls } from '@/lib/markdown'
import { openImageFromDom } from '@/stores/useImageLightbox'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { cn } from '@/lib/utils'
import { AGENT_ACTIONS as ACTIONS, runningOf, verbOf } from '@/lib/agentActivity'
import { colorOf, statusOfTool } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   工具调用列表

   从 ProcessBlocks.tsx 拆出来的（那边超 300 行了）。

   两件事：
     · **概览** —— 这轮几步、总共多久、几个失败，一眼看出干了多少活
     · **归类** —— 连续的同名调用合成一行（「读取 5 个文件」），
       否则 agent 一口气读十个文件就是十行卡片

   设计上跟着 dsh-watcher 的思路走：只总结**能确定**的事，不编。
   没收录的工具就老实用原名 + 次数。
   ══════════════════════════════════════════════════════════════ */

/* ── 工具调用列表 ─────────────────────────────────────────── */

/** 毫秒 → 人看的（<1s 给毫秒，<1min 给秒，再长给分秒） */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export interface ToolGroup {
  name: string
  ok: boolean
  runs: ToolRunRecord[]
  totalMs: number
}

/**
 * 同名的**连续**调用归成一组。
 *
 * 为什么限制「连续」：`读文件 → 改文件 → 读文件` 中间那次是另一回事，
 * 揉成一个「读取 2 个文件」会让人误以为是一起干的。
 * 另外**失败的不和成功归一组** —— 失败得看得见。
 */
export function groupRuns(runs: readonly ToolRunRecord[]): ToolGroup[] {
  const groups: ToolGroup[] = []
  for (const run of runs) {
    const last = groups[groups.length - 1]
    if (last && last.name === run.name && last.ok === run.ok) {
      last.runs.push(run)
      last.totalMs += run.ms ?? 0
      continue
    }
    groups.push({ name: run.name, ok: run.ok, runs: [run], totalMs: run.ms ?? 0 })
  }
  return groups
}

export function ToolRunList({ runs }: { runs: readonly ToolRunRecord[] }) {
  const [open, setOpen] = useState(false)
  if (runs.length === 0) return null
  const running = runs.some((run) => run.output === '' && run.ms === undefined)
  const failed = runs.some((run) => !run.ok && run.ms !== undefined)
  /* AG-008：具体说是哪个工具在跑，而不是一句「正在执行工具」 */
  const active = runningOf(runs)
  const label = active ? `正在${verbOf(active.name)}…` : failed ? '工具执行失败' : '已完成工具调用'

  /* 概览：几步、总共多久、几个失败 —— 一眼看出这轮干了多少活 */
  const totalMs = runs.reduce((sum, run) => sum + (run.ms ?? 0), 0)
  const failedCount = runs.filter((run) => !run.ok && run.ms !== undefined).length
  const groups = groupRuns(runs)

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
          <XCircle size={12} style={{ color: colorOf('failed') }} />
        ) : (
          <CheckCircle2 size={12} style={{ color: colorOf('completed') }} />
        )}
        <span>{label}</span>
        <span className="font-mono text-fg-tertiary">· {runs.length} 步</span>
        {totalMs > 0 ? (
          <span className="font-mono text-fg-tertiary">· {formatMs(totalMs)}</span>
        ) : null}
        {failedCount > 0 ? (
          <span className="font-mono" style={{ color: colorOf('failed') }}>
            · {failedCount} 个失败
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line-subtle p-1">
          {groups.map((group) =>
            group.runs.length === 1 ? (
              <ToolRunRow key={group.runs[0].id} run={group.runs[0]} />
            ) : (
              <ToolGroupRow key={group.runs[0].id} group={group} />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 一组同名调用：「读取 5 个文件」，展开才看每条 */
function ToolGroupRow({ group }: { group: ToolGroup }) {
  const [open, setOpen] = useState(false)
  const [verb, unit] = ACTIONS[group.name] ?? [group.name, '次']

  return (
    <div className="rounded-sm border border-line-subtle bg-bg-base/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-2xs hover:bg-bg-hover"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <CheckCircle2
          size={12}
          className="shrink-0"
          style={{ color: colorOf(statusOfTool(group.ok)) }}
        />
        <span className="shrink-0 text-fg-secondary">
          {verb} {group.runs.length} {unit}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg-tertiary">
          {group.runs[0].summary ?? ''}
        </span>
        <span className="shrink-0 font-mono text-fg-tertiary">{formatMs(group.totalMs)}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line-subtle p-1">
          {group.runs.map((run) => (
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
  /* 工具输出里可能带图片（生图、下载图之类）—— 单独抠出来渲染 */
  const images = extractImageUrls(run.output)

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
          <CheckCircle2 size={12} className="shrink-0" style={{ color: colorOf('completed') }} />
        ) : (
          <XCircle size={12} className="shrink-0" style={{ color: colorOf('failed') }} />
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

      {/*
        工具输出里的图片**不管折不折叠都显示**。
        工具输出是纯文本（<pre>），`![图](x)` 只会显示成一堆方括号 ——
        生图工具明明返回了图，用户却只看到文件路径。这里把图抠出来直接渲染。
      */}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-line-subtle px-2 py-2">
          {images.map((src) => (
            <img
              key={src}
              src={src}
              alt="工具产出的图片"
              loading="lazy"
              data-chat-image="true"
              className="max-h-48 cursor-zoom-in rounded border border-line-subtle"
              onClick={() => openImageFromDom(src)}
            />
          ))}
        </div>
      ) : null}

      {open && hasOutput ? (
        <pre className="max-h-64 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] text-fg-secondary whitespace-pre-wrap break-all">
          {run.output}
        </pre>
      ) : null}
    </div>
  )
}
