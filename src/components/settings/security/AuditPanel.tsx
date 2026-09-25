import { useState } from 'react'
import type { AuditEntry } from '@/types/backend'
import { LEVEL_COLOR, LEVEL_LABEL } from './meta'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   审计列表

   一行一次工具调用。点开看参数和结果（**已经脱敏过**）。
   价值在于事后能回答「这个文件是谁改的、那条命令是谁批的」。
   ══════════════════════════════════════════════════════════════ */

export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-2 text-dense text-fg-tertiary">还没有记录。</p>
  }

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry, index) => (
        <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
      ))}
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
