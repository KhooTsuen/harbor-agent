import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Thread } from '@/types'
import type { AuditEntry } from '@/types/backend'
import { LEVEL_COLOR, LEVEL_LABEL } from './meta'
import { colorOf } from '@/lib/statusLanguage'
import { useAppStore } from '@/stores/useAppStore'
import {
  groupAudit,
  runLabel,
  type AuditRun,
  type AuditSessionGroup,
  type AuditTaskGroup,
} from './auditGroups'

/* ══════════════════════════════════════════════════════════════
   审计列表：按「会话 → 任务 → 同类调用」折三层（真机反馈 8）

   以前是一列平铺：60 条 read_file 掺着 3 条 run_shell，一眼看不出
   「那次任务到底动了什么」。现在同一会话的事在一个块里，同一个工具连调
   12 次折成一行「read_file × 12」，点开才展开明细。

   价值不变：事后能回答「这个文件是谁改的、那条命令是谁批的」——
   只是从「翻列表」变成「按会话/任务找」。
   ══════════════════════════════════════════════════════════════ */

export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const threads = useAppStore((s) => s.threads)
  const groups = useMemo(() => groupAudit(entries), [entries])

  if (entries.length === 0) {
    return <p className="py-2 text-dense text-fg-tertiary">还没有记录。</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((group, index) => (
        <SessionBlock
          key={group.sessionId || 'no-session'}
          group={group}
          title={sessionTitle(group.sessionId, threads)}
          /* 最新的那个会话默认展开：打开面板就是想看刚发生的事 */
          defaultOpen={index === 0}
        />
      ))}
    </div>
  )
}

/** 会话号 → 人话。查得到标题就用标题（`sess_xxxx` 谁也认不出来） */
function sessionTitle(sessionId: string, threads: Thread[]): string {
  if (!sessionId) return '没有会话归属'
  return threads.find((t) => t.id === sessionId)?.title || sessionId.slice(0, 14)
}

function SessionBlock({
  group,
  title,
  defaultOpen,
}: {
  group: AuditSessionGroup
  title: string
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-sm border border-line-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-fg-tertiary" />
        )}
        <span
          className="min-w-0 flex-1 truncate text-2xs text-fg-secondary"
          title={group.sessionId}
        >
          {title}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{group.count} 次</span>
        {group.failed > 0 ? (
          <span className="shrink-0 text-2xs" style={{ color: colorOf('failed') }}>
            失败 {group.failed}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line-hairline px-2 py-1.5">
          {group.tasks.map((task) => (
            <TaskBlock key={task.taskId || 'no-task'} task={task} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TaskBlock({ task }: { task: AuditTaskGroup }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-fg-tertiary">
          {task.taskId ? `任务 ${task.taskId.slice(0, 10)}` : '不挂任务'}
        </span>
        <span className="font-mono text-2xs text-fg-tertiary">{task.count} 次</span>
      </div>
      {task.runs.map((run) => (
        <RunBlock key={run.tool} run={run} />
      ))}
    </div>
  )
}

/** 同一类工具的一行；点开才是逐条明细 */
function RunBlock({ run }: { run: AuditRun }) {
  const [open, setOpen] = useState(false)
  const latest = run.entries[0]
  const hint = String(latest?.error || latest?.result || '').slice(0, 80)

  return (
    <div className="rounded-sm border border-line-hairline bg-bg-raised/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <span className="shrink-0 font-mono text-2xs text-fg-secondary">{runLabel(run)}</span>
        {run.failed > 0 ? (
          <span className="shrink-0 text-2xs" style={{ color: colorOf('failed') }}>
            {run.failed} 次失败
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-tertiary">{hint}</span>
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{run.totalMs}ms</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 border-t border-line-hairline p-1">
          {run.entries.map((entry, index) => (
            <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
  const level = entry.extras?.risk?.level

  return (
    <div className="rounded-sm border border-line-hairline bg-bg-raised/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{time}</span>
        <span
          className="shrink-0 font-mono text-2xs"
          style={{ color: entry.ok ? undefined : colorOf('failed') }}
        >
          {entry.tool}
        </span>
        {level ? (
          <span className="shrink-0 text-2xs" style={{ color: LEVEL_COLOR[level] }}>
            {LEVEL_LABEL[level]}
          </span>
        ) : null}
        {entry.approval === false ? (
          <span className="shrink-0 text-2xs" style={{ color: colorOf('warning') }}>
            已拒绝
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-tertiary">
          {entry.error || String(entry.result ?? '').slice(0, 80)}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{entry.ms}ms</span>
      </button>
      {open ? (
        <pre className="overflow-x-auto border-t border-line-hairline px-2 py-1.5 font-mono text-2xs text-fg-secondary">
          {JSON.stringify(
            { args: entry.args, result: entry.result, risk: entry.extras?.risk },
            null,
            2,
          )}
        </pre>
      ) : null}
    </div>
  )
}
