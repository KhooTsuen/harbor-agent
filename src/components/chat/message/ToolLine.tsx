import { useId, useLayoutEffect, useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { AGENT_ACTIONS, homogeneousIconOf, verbOf, toolLabel } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { useScrollGuard } from '../scrollGuard'
import { formatMs, ToolRunRow } from '../ToolRuns'
import { stateOfRun } from '../toolRunState'
import { SubagentCard } from '../SubagentCard'
import '@/styles/conversation-tools.css'

const PAGE_SIZE = 100

/** 只对连续展示的调用做摘要，明细始终保留调用原顺序。 */
export function describeRuns(runs: readonly ToolRunRecord[]): string {
  if (runs.length === 0) return ''
  if (runs.length === 1) {
    const one = runs[0]
    const arg = String(one.summary ?? '').trim()
    if (arg) return verbOf(one.name) + ' ' + (arg.length > 48 ? arg.slice(0, 48) + '…' : arg)
    return toolLabel(one.name)
  }
  const buckets: Array<{ verb: string; unit: string; n: number }> = []
  for (const run of runs) {
    const [verb, unit] = AGENT_ACTIONS[run.name] ?? [run.name, '次']
    const hit = buckets.find((bucket) => bucket.verb === verb && bucket.unit === unit)
    if (hit) hit.n += 1
    else buckets.push({ verb, unit, n: 1 })
  }
  const head = buckets.slice(0, 3).map((bucket) => bucket.verb + ' ' + bucket.n + ' ' + bucket.unit)
  return head.join('、') + (buckets.length > head.length ? ' 等 ' + buckets.length + ' 类' : '')
}

export function ToolLine({
  runs,
  hideMeta = false,
  motion = false,
  anchorIds,
}: {
  runs: ToolRunRecord[]
  /** 当前执行仍活跃；历史中未收到终态的工具只能显示“结果未确认”。 */
  hideMeta?: boolean
  /** 只有本次实时到达的调用才进入动效，历史打开默认静态。 */
  motion?: boolean
  anchorIds?: Readonly<Record<string, string>>
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const [visited, setVisited] = useState(false)
  const [windowStart, setWindowStart] = useState<number | null>(null)
  const detailsId = useId()
  const guard = useScrollGuard()
  const states = runs.map((run) => stateOfRun(run, hideMeta))
  const running = states.includes('running')
  const failedCount = states.filter((state) => state === 'failed').length
  const pendingCount = states.filter((state) => state === 'unconfirmed').length
  const finished = states.filter((state) => state === 'completed' || state === 'failed').length
  const state = running
    ? 'running'
    : failedCount
      ? 'failed'
      : pendingCount
        ? 'unconfirmed'
        : 'completed'
  const open = manual ?? (failedCount > 0 && !running)
  const totalMs = runs.reduce((sum, run) => sum + (run.ms ?? 0), 0)
  const GroupIcon = homogeneousIconOf(runs)
  const hidden = windowStart ?? Math.max(0, runs.length - PAGE_SIZE)
  const shown = hidden > 0 ? runs.slice(hidden) : runs
  const color = running
    ? undefined
    : colorOf(failedCount ? 'failed' : pendingCount ? 'warning' : 'completed')
  useLayoutEffect(() => {
    if (open && windowStart === null) setWindowStart(Math.max(0, runs.length - PAGE_SIZE))
    else if (!open && windowStart !== null) setWindowStart(null)
  }, [open, windowStart, runs.length])
  if (runs.length === 0) return null

  return (
    <div className="flow-tool-group" data-tool-motion={motion || undefined}>
      <button
        type="button"
        onClick={() => {
          guard?.enterFree()
          setVisited(true)
          setManual(!open)
        }}
        aria-expanded={open}
        aria-controls={detailsId}
        className="flow-disclosure-trigger flow-tool-trigger"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={'flow-disclosure-chevron' + (open ? ' flow-disclosure-chevron-open' : '')}
        />
        {running ? (
          <Loader2 size={12} className="flow-tool-spinner shrink-0 text-fg-tertiary" />
        ) : failedCount > 0 ? (
          <XCircle size={12} className="shrink-0" style={{ color }} />
        ) : pendingCount > 0 ? (
          <AlertTriangle size={12} className="shrink-0" style={{ color }} />
        ) : null}
        {GroupIcon ? <GroupIcon size={12} className="shrink-0 text-fg-tertiary" /> : null}
        <span className="min-w-0 flex-1 truncate">{describeRuns(runs)}</span>
        {runs.length > 1 ? (
          <span
            key={finished}
            className="flow-tool-meta flow-tool-count"
            title="仅统计这组已知调用，不表示整个任务的总进度"
          >
            {finished}/{runs.length} 已完成
          </span>
        ) : null}
        <span key={state} className="flow-tool-status" data-tool-status={state} style={{ color }}>
          {running
            ? '进行中'
            : failedCount
              ? failedCount + ' 项失败'
              : pendingCount
                ? pendingCount + ' 项结果未确认'
                : '成功'}
        </span>
        {totalMs > 0 && !hideMeta ? (
          <span className="flow-tool-meta">· {formatMs(totalMs)}</span>
        ) : null}
      </button>

      {runs.map((run) =>
        run.subagent ? <SubagentCard key={'sub-' + run.id} trace={run.subagent} /> : null,
      )}

      <div
        ref={(element) => {
          if (element) element.inert = !open
        }}
        id={detailsId}
        className="flow-tool-details"
        data-open={open}
        aria-hidden={!open}
      >
        <div>
          {open || visited ? (
            <div className="flow-tool-children">
              {hidden > 0 ? (
                <button
                  type="button"
                  className="flow-tool-load-earlier"
                  onClick={() => {
                    guard?.enterFree()
                    setWindowStart(Math.max(0, hidden - PAGE_SIZE))
                  }}
                >
                  加载更早的 {Math.min(hidden, PAGE_SIZE)} 步（还有 {hidden} 步）
                </button>
              ) : null}
              {shown.map((run) => (
                <ToolRunRow
                  key={run.id}
                  run={run}
                  live={hideMeta}
                  motion={motion}
                  anchorId={anchorIds?.[run.id]}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
