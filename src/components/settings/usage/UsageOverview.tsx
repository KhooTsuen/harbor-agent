import type { UsageQueryResult } from '@/types/usage-query'
import { formatCount, formatTokens } from '@/lib/format'
import { StatCard } from '../parts/StatCard'
import { SectionTitle } from '../parts'
import { USAGE_RANGES, useUsageTabStore, type UsageRangeDays } from '@/stores/useUsageTabStore'
import { dayStateOf } from '@/lib/usageApi'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 统计概览

    ── 这一块最重要的不是数字，是**覆盖率** ──────────────────────
    用户看到「本月 120 万 token」会以为那就是全部消耗。但账本里可能有一半
    请求服务商根本没返回 usage —— 那部分消耗**未知**，不是 0。

    所以每张卡都遵守同一条规矩：
      · 数字只加 `known` 的那部分（内核已经算好，这里不再加）
      · 旁边一定跟着「已知 N / 未知 M」，让总量永远不被当成完整值

    ── 为什么「已记录」三个字要写在标题上 ────────────────────────
    「已记录」= 账本里确实有的。它可能小于真实消耗（缺 usage）、也可能包含
    老记录（`legacy`）。写清楚这个限定，比给个漂亮的总数更诚实。
    ══════════════════════════════════════════════════════════════ */

interface Props {
  data: UsageQueryResult
  /** 有没有筛选（筛了就不该叫「本月」） */
  filtered: boolean
}

/** 覆盖率 → 一句话（不编综合评分，只报客观比例） */
function coverageText(known: number, requests: number): string {
  if (requests === 0) return '这段时间账本里没有请求'
  const pct = Math.round((known / requests) * 100)
  if (known === requests) return `${requests} 次请求全部拿到真实 usage`
  return `${requests} 次请求里 ${known} 次有真实 usage（${pct}%），其余未知`
}

function RangePicker(): React.ReactElement {
  const rangeDays = useUsageTabStore((s) => s.rangeDays)
  const setRangeDays = useUsageTabStore((s) => s.setRangeDays)

  return (
    <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="统计时间范围">
      {USAGE_RANGES.map((item) => (
        <button
          key={item.days}
          type="button"
          role="radio"
          aria-checked={rangeDays === item.days}
          onClick={() => setRangeDays(item.days as UsageRangeDays)}
          className={cn(
            'rounded-sm border px-2 py-0.5 text-2xs transition-colors duration-fast',
            rangeDays === item.days
              ? 'border-line-focus bg-bg-hover text-fg-primary'
              : 'border-line-subtle text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function UsageOverview({ data, filtered }: Props): React.ReactElement {
  const t = data.totals
  const rangeDays = useUsageTabStore((s) => s.rangeDays)
  const rangeLabel = USAGE_RANGES.find((r) => r.days === rangeDays)?.label ?? ''

  /* 有记录但一次都没拿到 usage → 整个概览必须说「全是未知」，不能显示一排 0 */
  const allUnknown = t.requests > 0 && t.known === 0
  /* 老记录（没有 known 字段）单独点名：数值算了，但不是新口径采到的 */
  const legacyNote = t.legacy > 0 ? `其中 ${t.legacy} 条是老记录（当时没有 known 标记）` : ''

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle hint="数字来自服务商上报，本地不估算；缺失的请求不计入总量">
          统计概览
        </SectionTitle>
        <RangePicker />
      </div>

      {allUnknown ? (
        <p
          className="rounded-sm border border-line-hairline bg-bg-raised/40 px-3 py-2 text-dense leading-relaxed text-fg-secondary"
          role="status"
        >
          这{filtered ? '组筛选' : rangeLabel}内有 <strong>{t.requests}</strong> 次模型请求， 但
          <strong>一次都没有拿到真实 usage</strong>。
          <br />
          没有上报就是<strong>未知</strong>，不是 0 —— 所以这里不显示 token 总量，
          免得把「不知道」显示成「没消耗」。
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 py-1">
          <StatCard
            label="已记录总 token"
            value={t.total}
            hint={`已知 ${t.known} / 未知 ${t.unknown}${legacyNote ? ` · ${legacyNote}` : ''}`}
          />
          <StatCard
            label="模型请求"
            value={t.requests}
            hint={
              t.errors + t.aborted > 0
                ? `失败 ${t.errors} · 中止 ${t.aborted}（也计入请求数）`
                : '含重试与场景调用'
            }
          />
          <StatCard label="输入 token" value={t.prompt} hint="含缓存命中部分（不重复加）" />
          <StatCard label="输出 token" value={t.completion} hint="含思考 token（不重复加）" />
        </div>
      )}

      {/* 覆盖情况：这一行是「总量能不能当完整值」的唯一依据 */}
      <div className="rounded-sm border border-line-hairline bg-bg-raised/30 px-3 py-2 text-dense leading-relaxed text-fg-secondary">
        <span className="text-fg-primary">用量覆盖：</span>
        {coverageText(t.known, t.requests)}
        {t.unknown > 0 ? (
          <>
            <br />
            <span className="text-fg-tertiary">
              注意：覆盖率是<strong>请求数</strong>的比例，<strong>不是</strong> token 总量的准确率
              —— 缺的那几次可能消耗更多。
            </span>
          </>
        ) : null}
      </div>

      {/* 明细口径：缓存与思考的包含关系写死在这里，免得用户以为能相加 */}
      <details className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
        <summary className="cursor-pointer text-dense text-fg-secondary">这些数字怎么算的</summary>
        <ul className="mt-1.5 flex flex-col gap-0.5 text-2xs leading-relaxed text-fg-tertiary">
          <li>
            · 输入 {formatCount(t.prompt)} 里**已包含**缓存命中{' '}
            {t.cacheHit > 0 ? formatCount(t.cacheHit) : '（未上报或为 0）'} —— 再加一遍会重复。
          </li>
          <li>
            · 输出 {formatCount(t.completion)} 里**已包含**思考{' '}
            {t.reasoning > 0 ? formatCount(t.reasoning) : '（未上报或为 0）'} —— 同理。
          </li>
          <li>· 未知的 {t.unknown} 次请求：字段缺失按「没上报」处理，不进任何合计。</li>
          <li>
            · 按天归日用的是**本机时区**（
            {data.semantics.timezone === 'local' ? '本地' : data.semantics.timezone}），
            和你在界面上看到的「今天」一致。
          </li>
          <li>
            · 账本里一共 {formatCount(data.scanned)} 行，本次命中 {formatCount(data.matched)} 行。
          </li>
        </ul>
      </details>

      {/* 按天的最小提示：热力图在上面那块，这里只报「有几天真的没调用」 */}
      {data.days.length > 0 ? (
        <p className="px-1 text-2xs text-fg-tertiary">
          {data.days.filter((d) => dayStateOf(d) === 'none').length > 0
            ? `这段时间里有 ${data.days.filter((d) => dayStateOf(d) === 'none').length} 天完全没有调用（热力图上是空格）`
            : `这段时间每天都有调用，合计 ${formatTokens(t.total)} token`}
        </p>
      ) : null}
    </div>
  )
}
