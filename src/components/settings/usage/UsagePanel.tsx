import { useCallback, useEffect, useState } from 'react'
import type { LimitsGateState } from '@/types/stats'
import type { UsageQueryResult } from '@/types/usage-query'
import { emptyQueryResult, usageQuery } from '@/lib/usageApi'
import { statsSummary } from '@/lib/extrasApi'
import { useUsageTabStore } from '@/stores/useUsageTabStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { BudgetLimit } from '../tabs/BudgetLimit'
import { GateStatus } from '../tabs/GateStatus'
import { SectionTitle } from '../parts'
import { UsageOverview } from './UsageOverview'
import { UsageHeatmap } from './UsageHeatmap'
import { UsageBreakdown } from './UsageBreakdown'
import { UsageTrust } from './UsageTrust'
import { UsageCost } from './UsageCost'
import { UsageDetails } from './UsageDetails'

/* ══════════════════════════════════════════════════════════════
    「模型用量」页 —— 数据全部来自**真实账本**（`usage:query`）

    ── 和旧 `statsSummary` 的关系 ────────────────────────────────
    旧接口读的是 `stats.json` 累计桶：字段全是 number，老记录按 0 补，
    所以它**分不清「没上报」和「确实是 0」**。这一页不再用它取数。

    `settingsP4` 之前的 `UsageTab` 仍在（预算闸那两块是它的），
    但「花了多少」这件事已经整体搬到这一页的新口径上。

    ── 为什么日期范围每次现算 ────────────────────────────────────
    store 里只存「最近 N 天」。存死 `from/to` 的话，应用开一整夜之后
    「最近 30 天」就悄悄变成了「31 天前到昨天」。

    ── 为什么两块查询（聚合 + 明细）────────────────────────────
    聚合返回几十个小对象，明细可能几千行。分开拉，不看明细的人不付代价。
    ══════════════════════════════════════════════════════════════ */

/** 时间范围 → [from, to]（本地时区零点对齐，与内核按天归日同一口径） */
function rangeOf(days: number): { from: number; to: number } {
  const now = new Date()
  const to = now.getTime()
  if (days <= 0) return { from: 0, to }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return { from: start.getTime(), to }
}

export function UsagePanel(): React.ReactElement {
  const rangeDays = useUsageTabStore((s) => s.rangeDays)
  const providerId = useUsageTabStore((s) => s.providerId)
  const model = useUsageTabStore((s) => s.model)
  const taskId = useUsageTabStore((s) => s.taskId)

  const [data, setData] = useState<UsageQueryResult>(() => emptyQueryResult())
  const [loading, setLoading] = useState(true)
  const [ok, setOk] = useState(true)
  const [error, setError] = useState<string | undefined>('')
  /*
   * 闸门状态只能问内核（`limits.gateState()` 算的「今天/本月已用」）。
   * 界面自己拿上限和日期再算一遍就会出现两份日期口径 —— `limits.cjs` 的注释里
   * 记着这个坑（曾经错开，闸门永远算成 0）。所以这里只取 `gate` 一个字段，
   * token 数字一律走账本。
   */
  const [gate, setGate] = useState<LimitsGateState | undefined>(undefined)

  /* 预算闸的四个值：改了就静默重拉（闸门状态是内核算的，跟着 summary 一起变） */
  const gateOn = useConfigStore((s) => s.config?.limits.enabled)
  const daily = useConfigStore((s) => s.config?.limits.dailyTokens)
  const monthly = useConfigStore((s) => s.config?.limits.monthlyTokens)
  const onExceed = useConfigStore((s) => s.config?.limits.onExceed)

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!quiet) setLoading(true)
      const { from, to } = rangeOf(rangeDays)
      const res = await usageQuery({
        from,
        to,
        providerId,
        model,
        taskId,
        /* 热力图要能区分「这天没调用」，所以必须补齐空白日 */
        includeEmptyDays: true,
      })
      setData(res.data)
      setOk(res.ok)
      setError(res.error)
      /* 闸门跟着拉一次（同一轮里取，避免界面出现「用量是新的、闸门是旧的」） */
      try {
        const summary = await statsSummary()
        setGate(summary?.gate)
      } catch {
        /* 拿不到就当「不知道」：GateStatus 什么都不显示，不瞎猜 */
        setGate(undefined)
      }
      setLoading(false)
    },
    [rangeDays, providerId, model, taskId],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  /* 改预算上限：静默重拉（整页闪「读取中」反而看不清数字变没变） */
  useEffect(() => {
    if (gateOn === undefined) return
    void load(true)
    // eslint 依赖说明：gate 四项变化才重拉；load 已含其余依赖
  }, [gateOn, daily, monthly, onExceed, load])

  const filtered = Boolean(providerId || model || taskId)

  return (
    <div className="flex flex-col gap-2 pb-6">
      {/* 预算闸与真实用量是两件事：闸是「允许花多少」，用量是「实际花了多少」 */}
      <SectionTitle hint="到上限就拦（或只提醒）—— 判定在内核，这里只显示状态">
        用量闸（预算）
      </SectionTitle>
      <BudgetLimit />
      <GateStatus gate={gate} />

      {!ok ? (
        <p className="rounded-sm border border-line-hairline bg-bg-raised/40 px-3 py-2 text-dense leading-relaxed text-fg-secondary">
          用量查询失败：{error}
          <br />
          <span className="text-2xs text-fg-tertiary">
            下面显示的是空结果 —— 这**不是**「你没有消耗」，是账本没读到。
          </span>
        </p>
      ) : null}

      {loading ? (
        <p className="px-1 py-3 text-dense text-fg-tertiary">读取用量账本…</p>
      ) : (
        <>
          <UsageOverview data={data} filtered={filtered} />
          <UsageHeatmap days={data.days} />
          <UsageBreakdown data={data} />
          <UsageCost data={data} />
          <UsageTrust data={data} />
          <UsageDetails ok={ok} error={error} />
        </>
      )}
    </div>
  )
}
