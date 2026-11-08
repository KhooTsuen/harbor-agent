import { useMemo } from 'react'
import type { UsageQueryDay } from '@/types/usage-query'
import { dayStateOf } from '@/lib/usageApi'
import { formatCount } from '@/lib/format'
import { useUsageTabStore } from '@/stores/useUsageTabStore'
import { SectionTitle } from '../parts'
import { cn } from '@/lib/utils'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 每日 token 热力图

    ── 三种状态必须长得不一样（这是本块存在的理由）──────────────
      ① 这天**一次都没调用**  → 极淡的空格 + 虚线边（「什么都没有」）
      ② 有调用、用量**全部未知** → 橙色斜纹（「有消耗，但不知道多少」）
      ③ 有调用、用量已知        → 按 token 强度的色阶（0 也算已知，用最浅一档）

    以前把 ①②③ 画成同一种浅色，等于告诉用户「这天没用」，而实际可能是
    「用了但没记账」—— 那是把未知显示成零，正是这一阶段要根除的。

    ── 为什么不按「全量原始请求」现算 ────────────────────────────
    数据来自 `usage:query` 的 `days`（内核已聚合好，只重算 days，见
    `usage-query.cjs` 的 onlyTime 分支）。这里只做**渲染分级**，不遍历请求。

    ── 按周排布 ──────────────────────────────────────────────────
    每列一周（7 行），从左到右是周。跨月跨年交给 Date，不硬编码月份长度。
    ══════════════════════════════════════════════════════════════ */

/** 色阶：已知 token 的四档（0 已知单独用最浅一档，与「没调用」区分开） */
const LEVELS = [
  'bg-[color-mix(in_srgb,var(--accent-blue)_22%,transparent)]',
  'bg-[color-mix(in_srgb,var(--accent-blue)_42%,transparent)]',
  'bg-[color-mix(in_srgb,var(--accent-blue)_66%,transparent)]',
  'bg-[color-mix(in_srgb,var(--accent-blue)_92%,transparent)]',
]

/** 未知用量：橙色斜纹（用 CSS 渐变画，不引图片）—— 颜色取自状态语言表 */
function unknownStyle(): React.CSSProperties {
  const tone = colorOf('warning')
  return {
    backgroundImage: `repeating-linear-gradient(45deg, color-mix(in srgb, ${tone} 55%, transparent) 0 3px, transparent 3px 6px)`,
    borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`,
  }
}

interface Props {
  /** 按天升序；`includeEmptyDays: true` 时含空白日 */
  days: UsageQueryDay[]
}

/** 某个已用 token 数落在哪一档（对全体最大值做相对分级） */
function levelOf(total: number, max: number): number {
  if (max <= 0) return 0
  const ratio = total / max
  if (ratio > 0.66) return 3
  if (ratio > 0.33) return 2
  if (ratio > 0.08) return 1
  return 0
}

/** 把日期键 `YYYY-MM-DD` 转成「周几」（0=周日） */
function weekdayOf(day: string): number {
  const d = new Date(`${day}T00:00:00`)
  return Number.isNaN(d.getTime()) ? 0 : d.getDay()
}

export function UsageHeatmap({ days }: Props): React.ReactElement {
  const selectedDay = useUsageTabStore((s) => s.day)
  const pickDay = useUsageTabStore((s) => s.pickDay)

  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.total), 0), [days])

  /*
   * 按列（周）分组：首日前面补空位，让每周的格子竖直对齐 —— 否则同一个
   * 周几会落在不同行，「一周一行」的视觉规律就没了。
   */
  const columns = useMemo(() => {
    if (days.length === 0) return []
    const out: Array<Array<UsageQueryDay | null>> = []
    let current: Array<UsageQueryDay | null> = []
    const lead = weekdayOf(days[0].day)
    for (let i = 0; i < lead; i += 1) current.push(null)
    for (const day of days) {
      current.push(day)
      if (current.length === 7) {
        out.push(current)
        current = []
      }
    }
    if (current.length > 0) {
      while (current.length < 7) current.push(null)
      out.push(current)
    }
    return out
  }, [days])

  const totalRequests = days.reduce((sum, d) => sum + d.requests, 0)
  const unknownDays = days.filter((d) => dayStateOf(d) === 'partial').length
  const emptyDays = days.filter((d) => dayStateOf(d) === 'none').length

  if (days.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <SectionTitle hint="每天一格，颜色越深当天消耗越多">每日用量</SectionTitle>
        <p className="px-1 text-dense text-fg-tertiary">这段时间没有可显示的日子。</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="每天一格，颜色越深当天消耗越多；点一格筛选下方明细">
        每日用量
      </SectionTitle>

      <div className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2.5">
        {/* 星期标签 + 方格区：横向可滚，窄窗不撑破 */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          <div className="flex shrink-0 flex-col gap-[3px] pt-0.5 text-[10px] leading-[12px] text-fg-tertiary">
            {['日', '一', '二', '三', '四', '五', '六'].map((label) => (
              <span key={label} className="h-3">
                {label}
              </span>
            ))}
          </div>

          <div className="flex gap-[3px]">
            {columns.map((column, ci) => (
              <div key={ci} className="flex flex-col gap-[3px]">
                {column.map((day, di) => {
                  if (!day) return <span key={di} className="size-3" aria-hidden />
                  const state = dayStateOf(day)
                  const selected = selectedDay === day.day
                  return (
                    <button
                      key={day.day}
                      type="button"
                      data-day={day.day}
                      data-day-state={state}
                      aria-pressed={selected}
                      aria-label={
                        state === 'none'
                          ? `${day.day}：没有调用`
                          : `${day.day}：${day.requests} 次请求，已知 ${day.known} 次，共 ${day.total} token`
                      }
                      title={
                        state === 'none'
                          ? `${day.day} · 没有调用`
                          : `${day.day} · ${formatCount(day.total)} token · ${day.requests} 次请求（已知 ${day.known} / 未知 ${day.unknown}）`
                      }
                      onClick={() => pickDay(day.day)}
                      className={cn(
                        'size-3 rounded-[2px] border transition-colors duration-fast',
                        state === 'none' && 'border-dashed border-line-subtle bg-transparent',
                        state === 'known' &&
                          cn('border-transparent', LEVELS[levelOf(day.total, max)]),
                        state === 'zero' && 'border-line-subtle bg-bg-surface',
                        selected &&
                          'outline outline-1 outline-offset-1 outline-[var(--accent-blue)]',
                      )}
                      style={state === 'partial' ? unknownStyle() : undefined}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* 图例：三种状态各一条，别让用户猜颜色 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-tertiary">
          <span className="flex items-center gap-1">
            <span className="size-3 rounded-[2px] border border-dashed border-line-subtle" />
            没调用
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3 rounded-[2px] border border-line-subtle bg-bg-surface" />
            有调用但确认为 0
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3 rounded-[2px] border" style={unknownStyle()} />
            有调用但用量未知
          </span>
          <span className="flex items-center gap-1">
            <span className={cn('size-3 rounded-[2px]', LEVELS[1])} />
            <span className={cn('size-3 rounded-[2px]', LEVELS[3])} />
            已知消耗（由浅到深）
          </span>
        </div>

        <p className="mt-1.5 text-2xs leading-relaxed text-fg-tertiary">
          {days.length} 天里：{emptyDays} 天没调用 · {unknownDays} 天用量未知 · 共{' '}
          {formatCount(totalRequests)} 次请求
          {selectedDay ? ` · 已选中 ${selectedDay}（再点一次取消）` : ''}
        </p>
      </div>
    </div>
  )
}
