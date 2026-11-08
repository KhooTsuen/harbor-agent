import { useCallback, useEffect, useMemo, useState } from 'react'
import { USAGE_TASK_NONE, USAGE_UNSET } from '@/types/usage-query'
import { formatCount } from '@/lib/format'
import { usageQuery } from '@/lib/usageApi'
import { useUsageTabStore } from '@/stores/useUsageTabStore'
import { Button } from '@/components/ui/Button'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 请求明细（分页）

    ── 为什么单独拉一次 `withRows` ────────────────────────────────
    概览/热力图/排行只要聚合结果（IPC 传的是几十个小对象）；明细要原始行，
    可能成千上万条。分两次请求，才能让「只看统计」的人不付明细的代价。

    ── 为什么必须分页 ────────────────────────────────────────────
    账本会一直长。一次渲染几万行会让渲染进程直接卡死（AGENT.md 里
    「大量历史记录不会造成应用界面卡顿」这条硬要求）。这里每页 50 条。

    ── 分页在前端做，但数据只取一次 ──────────────────────────────
    翻页不重新查询（`rows` 已在内存）；只有筛选变化才重查。
    这样翻到第 20 页也不会有 20 次 IPC。
    ══════════════════════════════════════════════════════════════ */

const PAGE_SIZE = 50

/** 一行的形状（账本原始行里我们展示的那几个字段） */
interface Row {
  at?: number
  providerId?: string
  model?: string
  entry?: string
  purpose?: string
  taskId?: string
  sessionId?: string
  prompt?: number
  completion?: number
  total?: number
  cacheHit?: number
  reasoning?: number
  known?: boolean
  ok?: boolean
  outcome?: string
}

interface Props {
  /** 查询是否成功 —— 失败时明细不该说「没有记录」 */
  ok: boolean
  error?: string
}

/** 时间戳 → `MM-DD HH:mm`（本地时区，和账本归日口径一致） */
function timeOf(at?: number): string {
  const n = Number(at)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function UsageDetails({ ok, error }: Props): React.ReactElement {
  const rangeDays = useUsageTabStore((s) => s.rangeDays)
  const providerId = useUsageTabStore((s) => s.providerId)
  const model = useUsageTabStore((s) => s.model)
  const taskId = useUsageTabStore((s) => s.taskId)
  const day = useUsageTabStore((s) => s.day)

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [failReason, setFailReason] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setPage(0)
    /* 日期范围边界每次现算：存死时间戳会让「最近 30 天」慢慢漂成 31 天前 */
    const now = new Date()
    const to = now.getTime()
    const from =
      rangeDays > 0
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1)).getTime()
        : 0
    const res = await usageQuery({
      from,
      to,
      providerId,
      model,
      taskId,
      withRows: true,
    })
    if (!res.ok) {
      setRows([])
      setFailReason(res.error ?? '查询失败')
      setLoading(false)
      return
    }
    setFailReason('')
    /* 选中某天时只保留那一天（与热力图联动） */
    const all = (res.data.rows ?? []) as Row[]
    const kept = day
      ? all.filter((row) => {
          const n = Number(row.at)
          if (!Number.isFinite(n)) return false
          const d = new Date(n)
          const pad = (v: number): string => String(v).padStart(2, '0')
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === day
        })
      : all
    /* 新的在前：用户最关心刚发生的 */
    kept.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    setRows(kept)
    setLoading(false)
  }, [rangeDays, providerId, model, taskId, day])

  useEffect(() => {
    void load()
  }, [load])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const slice = useMemo(
    () => rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    [rows, current],
  )

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="每页 50 条，新的在前；点上面的模型/任务/日期会联动这里">
        请求明细
      </SectionTitle>

      {loading ? (
        <p className="px-1 py-2 text-dense text-fg-tertiary">读取中…</p>
      ) : failReason ? (
        <p className="rounded-sm border border-line-hairline bg-bg-raised/30 px-3 py-2 text-dense text-fg-secondary">
          明细读取失败：{failReason}
          <br />
          <span className="text-2xs text-fg-tertiary">
            这**不是**「没有记录」—— 是查询本身出了问题，换个筛选或稍后再试。
          </span>
        </p>
      ) : rows.length === 0 ? (
        <p className="px-1 py-2 text-dense text-fg-tertiary">
          {ok ? '当前筛选下没有请求记录。' : (error ?? '查询失败')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-sm border border-line-hairline">
            <table className="w-full min-w-[720px] border-collapse text-2xs">
              <thead>
                <tr className="border-b border-line-hairline text-left text-fg-tertiary">
                  <th className="px-2 py-1.5 font-normal">时间</th>
                  <th className="px-2 py-1.5 font-normal">供应商 / 模型</th>
                  <th className="px-2 py-1.5 font-normal">类别</th>
                  <th className="px-2 py-1.5 font-normal">归属</th>
                  <th className="px-2 py-1.5 text-right font-normal">输入</th>
                  <th className="px-2 py-1.5 text-right font-normal">输出</th>
                  <th className="px-2 py-1.5 text-right font-normal">合计</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((row, i) => {
                  const unknown = row.known === false
                  return (
                    <tr
                      key={`${row.at}-${i}`}
                      className="border-b border-line-hairline last:border-b-0 hover:bg-bg-hover"
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-fg-secondary">
                        {timeOf(row.at)}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-fg-primary">
                        {row.providerId || '—'}
                        <span className="text-fg-tertiary"> / {row.model || '—'}</span>
                        <span className="ml-1 text-fg-tertiary">
                          ({row.entry === 'cli' ? 'CLI' : 'API'})
                        </span>
                      </td>
                      <td className="px-2 py-1 text-fg-secondary">{row.purpose || USAGE_UNSET}</td>
                      <td
                        className="max-w-[160px] truncate px-2 py-1 font-mono text-fg-tertiary"
                        title={row.taskId || ''}
                      >
                        {row.taskId || USAGE_TASK_NONE}
                      </td>
                      {unknown ? (
                        <td colSpan={3} className="px-2 py-1 text-right text-fg-tertiary">
                          用量未知（未上报）
                        </td>
                      ) : (
                        <>
                          <td className="px-2 py-1 text-right font-mono text-fg-secondary">
                            {formatCount(Number(row.prompt) || 0)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-fg-secondary">
                            {formatCount(Number(row.completion) || 0)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-fg-primary">
                            {formatCount(Number(row.total) || 0)}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2 text-2xs text-fg-tertiary">
            <span>
              共 {formatCount(rows.length)} 条 · 第 {current + 1} / {pageCount} 页
              {day ? ` · 已筛 ${day}` : ''}
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={current === 0}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={current >= pageCount - 1}
              >
                下一页
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
