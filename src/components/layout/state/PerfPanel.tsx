import { useEffect } from 'react'
import { Gauge } from 'lucide-react'
import { usePerfStore } from '@/stores/usePerfStore'
import { useAgentActive } from '@/hooks/useAgentActive'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   性能（AG-037）

   「有点慢」这三个字在定位瓶颈时完全不够用 —— 得能指出时间花在哪一段：

     · 反馈     按下发送 → 第一条事件（这段时间用户面对的是「没反应」）
     · 首字上屏 按下发送 → 第一个字**真的画在屏幕上**
     · 分段     上下文构建 / 模型调用 / 工具 / 搜索
     · 总计     按下发送 → 整轮结束

   两条数据来源：分段与总计来自内核（`metrics.cjs` 的时间线），
   首字上屏由渲染层自己测（IPC + React 那一段主进程看不到）。

   放在「状态」标签里而不是新开一个标签：AG-030 刚把噪音收拾干净，
   而这和「现在卡在哪」本来就是同一件事。
   ══════════════════════════════════════════════════════════════ */

const fmt = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function PerfPanel({ threadId }: { threadId?: string }) {
  const recent = usePerfStore((s) => s.recent)
  const firstPaintMs = usePerfStore((s) => s.firstPaintMs)
  const refresh = usePerfStore((s) => s.refresh)
  const active = useAgentActive(threadId)

  /*
   * 挂载时读一次；每次「跑完」再读一次（时间线是内核在收尾时算的，
   * 运行中去问只会拿到上一轮）。空闲时不轮询 —— 性能数据不会自己变。
   */
  useEffect(() => {
    if (!active) void refresh()
  }, [active, refresh])

  const latest = recent[0]

  return (
    <section aria-label="性能" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-2xs text-fg-tertiary">
        <Gauge size={12} />
        性能 · 最近一轮
      </h3>

      {!latest ? (
        <p className="text-xs text-fg-tertiary">
          {active ? '跑完一轮就会有数据。' : '还没有数据 —— 发一句话试试。'}
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-0.5 text-2xs">
            <Row
              label="首条反馈"
              value={fmt(latest.firstFeedbackMs)}
              hint="这段时间用户面对的是「没反应」"
            />
            <Row
              label="首字上屏"
              value={fmt(firstPaintMs)}
              hint={
                latest.ttftMs !== null
                  ? `内核 TTFT ${fmt(latest.ttftMs)} —— 差值是 IPC 与渲染`
                  : '从按下发送到第一个字画在屏幕上'
              }
            />
            <Row label="整轮" value={fmt(latest.totalMs)} hint="按下发送 → 整轮结束" />
          </dl>

          {/* 时间花在哪：条形按占「总计」的比例，一眼看出大头 */}
          <div className="flex flex-col gap-1 rounded-sm border border-line-hairline bg-bg-raised/40 p-2">
            <Segment label="上下文构建" ms={latest.contextMs} total={latest.totalMs} />
            <Segment
              label={`模型调用${latest.llmCalls > 1 ? ` ×${latest.llmCalls}` : ''}`}
              ms={latest.llmMs}
              total={latest.totalMs}
              hint={latest.llmCalls > 1 ? `最慢一次 ${fmt(latest.llmMaxMs)}` : undefined}
            />
            <Segment
              label={`工具${latest.toolCalls > 1 ? ` ×${latest.toolCalls}` : ''}`}
              ms={latest.toolMs}
              total={latest.totalMs}
            />
            {latest.searchCalls > 0 ? (
              <Segment
                label={`搜索 ×${latest.searchCalls}`}
                ms={latest.searchMs}
                total={latest.totalMs}
              />
            ) : null}
          </div>
        </>
      )}

      {recent.length > 1 ? (
        <div className="flex flex-col gap-0.5">
          <h4 className="text-2xs text-fg-tertiary">更早</h4>
          {recent.slice(1, 5).map((item) => (
            <p
              key={item.traceId + item.requestTime}
              className="font-mono text-2xs text-fg-tertiary"
            >
              {fmt(item.totalMs)} · 模型 {fmt(item.llmMs)} · 工具 {fmt(item.toolMs)}
              {item.searchCalls > 0 ? ` · 搜索 ${fmt(item.searchMs)}` : ''}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fg-secondary" title={hint}>
        {label}
      </dt>
      <dd className="font-mono text-fg-primary">{value}</dd>
    </div>
  )
}

/** 一段耗时：数字 + 按占整轮比例画的条 */
function Segment({
  label,
  ms,
  total,
  hint,
}: {
  label: string
  ms: number
  total: number | null
  hint?: string
}) {
  const ratio = total && total > 0 ? Math.min(1, ms / total) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-2xs text-fg-secondary" title={hint ?? label}>
        {label}
      </span>
      <span className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-pill bg-bg-hover">
        <span
          className={cn('block h-full rounded-pill')}
          style={{
            width: `${Math.max(ratio * 100, ms > 0 ? 2 : 0)}%`,
            background: 'var(--accent-blue)',
          }}
        />
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-2xs text-fg-secondary">
        {fmt(ms)}
      </span>
    </div>
  )
}
