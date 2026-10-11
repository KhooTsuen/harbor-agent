import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Check, Copy, FolderOpen, RefreshCw } from 'lucide-react'
import type { ErrorEntry, ErrorSeverity } from '@/types/errors'
import { formatReport } from '@/lib/errorsApi'
import { openDataDir } from '@/lib/diagnosticsApi'
import { useErrorsStore } from '@/stores/useErrorsStore'
import { STATUS_CLASS, type UiStatus } from '@/lib/statusLanguage'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   错误清单（右栏「错误」标签）

   数据来自**内核在出错第一现场记的**（`electron/core/error-observer.cjs` →
   `data/errors/*.jsonl`），不是从日志里回头猜的 —— 所以每条都带着分类、
   环节（ipc / tool / model / mcp / pty）和能去查的坐标。

   和命令行的分工：命令行看 **6 个来源**（连自检噪音一起，排查历史用）；
   这里只看观察哨这一路（干净、字段归一化）。严重性口径两边共用内核那一份。

   三条自我约束：
     · **只读** —— 面板只列，不删、不清（清理由观察哨启动时按保留期做）
     · 打开时拉一次 + 手动刷新，**不轮询**（和「空闲不动」的原则一致）
     · `ok: false` 要照实说「读不出来」，不能显示成「一切正常」——
       把读失败显示成没错误，是最误导人的一种显示

   ★ Phase 1 · A1：抓取已收到 `useErrorsStore`（角标与这里读**同一份**）。
     打开面板只把「未读」提示清零（acknowledge），**不**把错误标记为已处理 ——
     错误仍在清单里、仍是未解决（面板只读，不删不改）。

   颜色一律走 `statusLanguage` 那一份（有测试盯着：组件里直接写 var(--danger) 会红）。
   ══════════════════════════════════════════════════════════════ */

/** 严重性 → 状态视觉语言。P2/P3 都属于「不是故障」，共用中性色（靠文字区分） */
const SEV_STATUS: Record<ErrorSeverity, UiStatus> = {
  P0: 'failed',
  P1: 'warning',
  P2: 'neutral',
  P3: 'neutral',
}

/** 时间窗选项（天数写在这里一处） */
const WINDOWS: readonly { days: number; label: string }[] = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
]

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ErrorsPanel(): ReactElement {
  const [days, setDays] = useState(7)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')

  /* 同一份数据来自 store（角标也读它）—— 面板不再自己抓一份 */
  const result = useErrorsStore((s) => s.snapshot)
  const loading = useErrorsStore((s) => s.loading)

  /* 打开这一页 = 看过了：只清「未读」提示，不声称已处理（错误照旧列在下面） */
  useEffect(() => {
    useErrorsStore.getState().acknowledge()
  }, [])

  useEffect(() => {
    void useErrorsStore.getState().refresh(days)
  }, [days])

  const load = useCallback(() => {
    void useErrorsStore.getState().refresh(days)
  }, [days])

  /** 按严重性分组（顺序由后端给，别在组件里另排一套） */
  const groups = useMemo(() => {
    const order = result?.severityOrder ?? ['P0', 'P1', 'P2', 'P3']
    const label = result?.severityLabel ?? {}
    return order
      .map((sev) => ({
        sev,
        title: label[sev] ?? sev,
        list: (result?.entries ?? []).filter((e) => e.severity === sev),
      }))
      .filter((g) => g.list.length > 0)
  }, [result])

  const copy = useCallback(async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(formatReport(result))
      setCopied(true)
      setNotice('')
      /* 一秒半后自己收回去，不用用户点第二下 */
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice('复制失败（系统剪贴板不可用）')
    }
  }, [result])

  const openDir = useCallback(async () => {
    const r = await openDataDir()
    if (!r.ok) setNotice(r.error ?? '打不开数据目录')
  }, [])

  const stats = result?.stats
  const failed = result?.ok === false

  return (
    <div aria-label="错误清单" className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：窗口 / 刷新 / 复制 / 打开目录 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-1">
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            onClick={() => setDays(w.days)}
            aria-pressed={days === w.days}
            className={cn(
              'rounded-sm px-1.5 py-0.5 text-2xs transition-colors duration-fast',
              days === w.days
                ? 'bg-bg-hover text-fg-primary'
                : 'text-fg-tertiary hover:bg-bg-hover hover:text-fg-secondary',
            )}
          >
            {w.label}
          </button>
        ))}
        <span className="ml-auto shrink-0 font-mono text-2xs text-fg-tertiary">
          {stats ? `${stats.unique ?? 0} 种 / ${stats.total ?? 0} 次` : ''}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="复制清单"
          title="复制成 Markdown，可直接粘给别人"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={() => void openDir()}
          aria-label="打开数据目录"
          title={`打开数据目录（错误记录在 ${result?.dir || 'data/errors'}）`}
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
        >
          <FolderOpen size={13} />
        </button>
        <button
          type="button"
          onClick={load}
          aria-label="刷新错误清单"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/*
        Phase 1 · A1：把「未读」和「未解决」说清楚 —— 打开这一页只清掉角标，
        不代表问题被处理了。有记录时才显示这句，没记录时不占地方。
      */}
      {result && result.ok && result.entries.length > 0 ? (
        <p className="shrink-0 border-b border-line-subtle px-2 py-1 text-2xs text-fg-tertiary">
          这里只记录、不改动。打开这一页只清掉「未读」提示 ——
          错误本身不会消失，也不会被标记为已处理。
        </p>
      ) : null}

      {notice ? <p className="shrink-0 px-2 py-1 text-2xs text-fg-secondary">{notice}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {failed ? (
          /* 读不出来 ≠ 没错误 —— 这两件事必须分开显示 */
          <p className="rounded-sm border border-line-hairline bg-bg-raised/40 px-2 py-2 text-xs text-fg-secondary">
            读不出错误清单：{result?.reason || '原因不明'}
          </p>
        ) : groups.length === 0 ? (
          <p className="px-1 py-4 text-center text-2xs text-fg-tertiary">
            {loading
              ? '正在读…'
              : `最近 ${days} 天没有记录到错误。出现问题时这里会自己出现记录（只记不修）。`}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <section key={group.sev}>
                <h3 className="flex items-center gap-1.5 text-2xs text-fg-tertiary">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      STATUS_CLASS[SEV_STATUS[group.sev]].bg,
                    )}
                    aria-hidden
                  />
                  {group.title}
                  <span>{group.list.reduce((n, e) => n + e.count, 0)} 次</span>
                </h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {group.list.map((entry) => (
                    <ErrorRow key={entry.key} entry={entry} />
                  ))}
                </ul>
              </section>
            ))}
            {result?.truncated ? (
              <p className="text-2xs text-fg-tertiary">（条数太多，只显示了前面一部分）</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 一条：默认一行摘要，点开看细节（`<details>` 自带展开，不用额外状态）。
 * 字段全部兜底 —— 磁盘上的东西当成不可信（审计面板那边被写坏的文件坑过）。
 */
function ErrorRow({ entry }: { entry: ErrorEntry }) {
  const tone = STATUS_CLASS[SEV_STATUS[entry.severity] ?? 'neutral']
  return (
    <li className="rounded-sm border border-line-hairline bg-bg-raised/30">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-xs text-fg-secondary hover:bg-bg-hover">
          <span className={cn('size-1.5 shrink-0 rounded-full', tone.bg)} aria-hidden />
          <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{entry.kind}</span>
          <span className="min-w-0 flex-1 truncate" title={entry.message}>
            {entry.message}
          </span>
          {entry.count > 1 ? (
            <span className="shrink-0 font-mono text-2xs text-fg-tertiary">×{entry.count}</span>
          ) : null}
          <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
            {fmtTime(entry.lastSeen)}
          </span>
        </summary>
        <div className="flex flex-col gap-1 border-t border-line-hairline px-2 py-1 text-2xs text-fg-tertiary">
          {entry.hint ? <p className="text-fg-secondary">建议：{entry.hint}</p> : null}
          <p>
            位置：<span className="font-mono text-fg-secondary">{entry.location}</span>
          </p>
          <p>
            首次 {fmtTime(entry.firstSeen)} · 最后 {fmtTime(entry.lastSeen)} · 共 {entry.count} 次
          </p>
          {entry.context?.tool ? <p>工具：{entry.context.tool}</p> : null}
          {entry.raw ? (
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-bg-canvas/40 p-1.5 font-mono text-2xs text-fg-secondary">
              {entry.raw}
            </pre>
          ) : null}
        </div>
      </details>
    </li>
  )
}
