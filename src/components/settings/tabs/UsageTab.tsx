import { useEffect, useState } from 'react'
import { BarChart3, RotateCcw } from 'lucide-react'
import type { StatsSummary, UsageBucket } from '@/types/backend'
import { statsReset, statsSummary } from '@/lib/extrasApi'
import { formatCount, formatTokens } from '@/lib/format'
import { useUIStore } from '@/stores/useUIStore'
import { BudgetLimit } from './BudgetLimit'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 用量

   token 数由服务端返回（不是本地估的）。用第三方中转时服务端可能不给
   usage，那种情况下这里记不上 —— 这一项本来就是尽力而为。

   为什么值得单独一页：agent 一次任务会连着调好几次模型，不记的话
   用户对「这软件有多费钱」完全没有感觉。
   ══════════════════════════════════════════════════════════════ */

const n = formatCount
const short = formatTokens

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2.5">
      <div className="text-2xs text-fg-tertiary">{label}</div>
      <div className="mt-0.5 font-mono text-lg leading-tight text-fg-primary">{n(value)}</div>
      {hint ? <div className="mt-0.5 text-dense text-fg-tertiary">{hint}</div> : null}
    </div>
  )
}

/** 一行条形：宽度按占最大值的比例 */
function Bar({ bucket, max }: { bucket: UsageBucket; max: number }) {
  const ratio = max > 0 ? Math.max(2, (bucket.total / max) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-surface">
      <div
        className="h-full rounded-full"
        /* 用主题色而不是 --border-focus（那是个接近纯白的边框色，
                     当条形图看着像一条高亮白条，太抢眼） */
        style={{
          width: `${ratio}%`,
          background: 'color-mix(in srgb, var(--accent-blue) 65%, transparent)',
        }}
      />
    </div>
  )
}

export function UsageTab() {
  const [data, setData] = useState<StatsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  async function refresh(): Promise<void> {
    setLoading(true)
    setData(await statsSummary())
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (loading) return <p className="py-4 text-dense text-fg-tertiary">读取中…</p>
  if (!data) return null

  const maxDay = Math.max(...data.days.map((d) => d.total), 0)
  const maxModel = Math.max(...data.models.map((m) => m.total), 0)
  const isEmpty = data.total.calls === 0

  return (
    <div className="py-1">
      <SectionTitle>用量闸（预算）</SectionTitle>
      <BudgetLimit />

      <SectionTitle>用量</SectionTitle>

      {isEmpty ? (
        <EmptyState
          icon={<BarChart3 size={22} />}
          title="还没有记录"
          description="和模型对话之后，这里会显示 token 用量。数字由服务端返回，本地不估算。"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 py-3">
            <StatCard label="输入 token" value={data.total.prompt} />
            <StatCard label="输出 token" value={data.total.completion} />
            <StatCard
              label="合计"
              value={data.total.total}
              hint={`开始于 ${new Date(data.since).toLocaleDateString('zh-CN')}`}
            />
            <StatCard label="调用次数" value={data.total.calls} hint="一轮任务可能调多次" />
            <StatCard
              label="缓存命中"
              value={data.total.cached}
              hint={
                data.total.prompt > 0
                  ? `占输入 ${Math.round((data.total.cached / data.total.prompt) * 100)}%`
                  : '前缀命中的 token 更便宜'
              }
            />
          </div>

          {data.models.length > 0 ? (
            <>
              <SectionTitle>按模型</SectionTitle>
              <ul className="flex flex-col gap-2 py-2">
                {data.models.map((m) => (
                  <li key={m.model} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-2xs text-fg-primary">{m.model}</span>
                      <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                        {short(m.total)} · {m.calls} 次
                      </span>
                    </div>
                    <Bar bucket={m} max={maxModel} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {data.days.length > 0 ? (
            <>
              <SectionTitle>最近 30 天</SectionTitle>
              <ul className="flex flex-col gap-2 py-2">
                {data.days.map((d) => (
                  <li key={d.day} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-2xs text-fg-secondary">{d.day}</span>
                      <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                        {short(d.total)} · {d.calls} 次
                      </span>
                    </div>
                    <Bar bucket={d} max={maxDay} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}

      <Row label="清空统计" hint="只删用量记录，不影响任何对话">
        <Button
          variant="danger"
          size="sm"
          icon={<RotateCcw size={13} />}
          disabled={isEmpty}
          onClick={() =>
            askPermission({
              kind: 'clear-data',
              title: '清空用量统计？',
              description: '删掉之后累计数字从零开始。这个操作不能撤销。',
              confirmText: '清空',
              danger: true,
              onConfirm: () => {
                void (async () => {
                  const ok = await statsReset()
                  await refresh()
                  showToast(ok ? 'success' : 'error', ok ? '已清空' : '清空失败')
                })()
              },
            })
          }
        >
          清空
        </Button>
      </Row>
    </div>
  )
}
