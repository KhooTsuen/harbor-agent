import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import type { AuditEntry } from '@/types/safety'
import { auditList } from '@/lib/safetyApi'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   运行日志

   Agent 每次工具调用的流水（时间 / 工具 / 状态 / 耗时 / 摘要）。
   数据来自主进程的审计日志（已经脱敏），全局可搜 —— 补的是
   「工具调用记录出了那条对话就再也找不到」这个缺口。

   不常驻轮询：打开时拉一次 + 手动刷新。和「空闲时不轮询」的原则一致。
   ══════════════════════════════════════════════════════════════ */

const PAGE_LIMIT = 200

/**
 * 一行日志的摘要：优先 error → 受影响文件 → 网络目标 → 结果，取第一个非空。
 *
 * 字段一律兜底：审计文件可以被外部写坏 —— 破坏性测试里实测过，手工塞一条
 * `{"ts":1,"tool":"x"}` 就够让这里抛 TypeError，而读它的组件一抛就白屏。
 * **磁盘上的东西永远当成不可信**。
 */
export function summarize(entry: AuditEntry): string {
  if (entry.error) return entry.error
  const files = entry.affectedFiles ?? []
  if (files.length > 0) return files[0]
  if (entry.networkTarget) return entry.networkTarget
  if (entry.result) return entry.result
  return ''
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ToolLogPanel(): ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { entries: list } = await auditList({ limit: PAGE_LIMIT })
    setEntries(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) =>
      [
        entry.tool,
        entry.error,
        entry.result,
        entry.networkTarget,
        ...(entry.affectedFiles ?? []),
      ].some((s) =>
        String(s ?? '')
          .toLowerCase()
          .includes(q),
      ),
    )
  }, [entries, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-1">
        <Search size={13} className="shrink-0 text-fg-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工具、输出、文件…"
          aria-label="搜索日志"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
          {filtered.length}/{entries.length}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="刷新日志"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-2xs text-fg-tertiary">
            {entries.length === 0
              ? '还没有工具调用记录。让 Agent 干点活，这里就会出现流水。'
              : '没有匹配的记录'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((entry, index) => (
              <LogRow key={`${entry.startedAt}-${entry.tool}-${entry.ts}-${index}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function LogRow({ entry }: { entry: AuditEntry }) {
  const summary = summarize(entry)
  return (
    <li
      className="flex items-center gap-2 border-b border-line-subtle/40 px-2 py-1 text-xs last:border-b-0"
      title={summary}
    >
      <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
        {fmtTime(Number(entry.ts) || 0)}
      </span>
      <span
        className={cn('shrink-0 font-mono text-2xs', entry.ok ? 'text-fg-secondary' : '')}
        style={entry.ok ? undefined : { color: 'var(--danger)' }}
      >
        {entry.tool ?? '(未知工具)'}
      </span>
      <span
        className="shrink-0 font-mono text-2xs"
        style={{ color: entry.ok ? 'var(--success)' : 'var(--danger)' }}
      >
        {entry.ok ? '✓' : '✗'}
      </span>
      <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
        {Number(entry.ms) || 0}ms
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-tertiary">{summary}</span>
    </li>
  )
}
