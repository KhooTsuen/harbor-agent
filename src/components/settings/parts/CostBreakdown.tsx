import type { ReactNode } from 'react'
import type { PricingConfig } from '@/types/pricing'
import type { StatsSummary, UsageBucket } from '@/types/backend'
import { formatCount, formatMoney } from '@/lib/format'
import { estimateCost, priceOf, tierOf, type CostEstimate, type TokenSplit } from '@/lib/pricing'
import { STATUS_META } from '@/lib/statusLanguage'
import { SectionTitle } from '../parts'
import { StatCard } from './StatCard'

/* ══════════════════════════════════════════════════════════════
   花费构成（A-展示 · 第三批）

   ★ 三条口径（用户拍的板，改之前先问）：
     ① **估算，不是账单**：`auto` 按「此刻」那一档折算，不是每笔调用各自的时刻
        （聚合桶里没有时刻）。界面上必须写明，别让人拿它去对账。
     ② **推理不是独立计费桶**：它是 `completion` 的子集（官方也不单列推理价），
        已经在「输出」那一格算过钱 —— 再算一次就是重复计费。
     ③ **查不到价就只显示 token**（`priceOf` 返回 null）—— 绝不用别的模型的价猜。

   放在 `parts/` 而不是塞进 `UsageTab.tsx`：那边加了这一节就顶到 300 行。
   ══════════════════════════════════════════════════════════════ */

/**
 * 桶 → 折算要用的三项。
 *
 * ★ 未命中 = `prompt − cached`，**不要用 `cacheMiss`** —— 那个字段只在
 *   hit/miss 都返回时才有（实测 5702 行里漏 64 行），用它等于少算钱。
 */
function splitOf(bucket: UsageBucket): TokenSplit {
  const prompt = Number(bucket.prompt) || 0
  const cached = Number(bucket.cached) || 0
  return {
    inMiss: Math.max(0, prompt - cached),
    inHit: cached,
    out: Number(bucket.completion) || 0,
  }
}

/**
 * 按模型逐个折算再求和。
 *
 * 为什么不拿 `total` 直接折：总量桶**没有模型名**，`priceOf` 无从查起。
 * 逐模型走三级匹配（第二级「唯一命中」正是为这个场景留的）才是准的。
 *
 * @returns `lines = null` 表示**一个模型都没配上价** → 整节只显示 token
 */
export function costLinesOf(
  models: Array<UsageBucket & { model: string }>,
  pricing: PricingConfig | null,
): { lines: CostEstimate | null; unpriced: number } {
  let inMiss = 0
  let inHit = 0
  let out = 0
  let priced = 0
  let unpriced = 0
  let tier = tierOf(pricing)

  for (const m of models) {
    const est = estimateCost(splitOf(m), priceOf(pricing, undefined, m.model), pricing)
    if (!est) {
      unpriced += 1
      continue
    }
    inMiss += est.inMiss
    inHit += est.inHit
    out += est.out
    tier = est.tier
    priced += 1
  }

  if (priced === 0) return { lines: null, unpriced }
  return { lines: { inMiss, inHit, out, total: inMiss + inHit + out, tier }, unpriced }
}

/** 这一节用的是哪一档 —— 说清「按什么时候的价估的」 */
function tierNote(pricing: PricingConfig | null, tier: 'peak' | 'offPeak'): string {
  const which = tier === 'peak' ? '高峰价' : '空闲价'
  const pinned = pricing?.peakMode === 'peak' || pricing?.peakMode === 'offPeak'
  return pinned ? `按${which}估算（配置里钉死这一档）` : `按当前时段价估算 · 此刻是${which}`
}

/** 单行用的金额串：查不到价 → `null`（界面就不显示金额，不猜） */
export function moneyOfBucket(
  bucket: UsageBucket,
  pricing: PricingConfig | null,
  model?: string,
): string | null {
  const est = estimateCost(splitOf(bucket), priceOf(pricing, undefined, model), pricing)
  return est ? formatMoney(est.total, pricing?.currency ?? 'CNY') : null
}

/** 一行提醒 —— 用状态语言表取色（AG-031：组件里不许自己写语义色） */
function Note({ status, children }: { status: 'warning' | 'neutral'; children: ReactNode }) {
  return (
    <li className="flex items-start gap-1.5 text-dense text-fg-secondary">
      <span
        className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: STATUS_META[status].color }}
      />
      <span>{children}</span>
    </li>
  )
}

export function CostBreakdown({
  data,
  pricing,
}: {
  data: StatsSummary
  pricing: PricingConfig | null
}) {
  const { lines, unpriced } = costLinesOf(data.models, pricing)
  const currency = pricing?.currency ?? 'CNY'
  const split = splitOf(data.total)
  const out = Number(data.total.completion) || 0
  const reasoning = Number(data.total.reasoning) || 0
  const reasoningPct = out > 0 ? Math.round((reasoning / out) * 100) : 0
  const inTotal = split.inMiss + split.inHit
  const hitPct = inTotal > 0 ? Math.round((split.inHit / inTotal) * 100) : 0
  const money = (value: number): string | null => (lines ? formatMoney(value, currency) : null)

  return (
    <>
      <SectionTitle hint={lines ? tierNote(pricing, lines.tier) : '未配置单价，只显示 token'}>
        花费构成
      </SectionTitle>

      <div className="grid grid-cols-2 gap-2 py-3">
        <StatCard
          label="输入未命中（全价）"
          value={split.inMiss}
          money={money(lines?.inMiss ?? 0)}
          hint={`共输入 ${formatCount(data.total.prompt)}，未命中占 ${100 - hitPct}%`}
        />
        <StatCard
          label="输入命中（缓存）"
          value={split.inHit}
          money={money(lines?.inHit ?? 0)}
          hint={`占输入 ${hitPct}% · 单价便宜得多`}
        />
        <StatCard
          label="输出（含推理）"
          value={out}
          money={money(lines?.out ?? 0)}
          hint={`推理 ${reasoningPct}% 已在其中计费`}
        />
        <StatCard
          label="其中 · 推理"
          value={reasoning}
          money={null}
          hint="属于输出的一部分，不单独计价"
        />
      </div>

      {lines ? (
        <div className="mb-2 flex items-baseline justify-between gap-2 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2">
          <span className="text-2xs text-fg-tertiary">合计（估算）</span>
          <span className="font-mono text-sm text-fg-primary">
            {formatMoney(lines.total, currency)}
          </span>
        </div>
      ) : (
        <p className="mb-2 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2 text-dense text-fg-tertiary">
          未配置单价，只显示 token 数。可以在 config.json 的 <code>pricing</code> 段里填单价,
          或用内置的 DeepSeek 官方价（模型名要与价目表一致）。
        </p>
      )}

      <ul className="mb-2 flex flex-col gap-1 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2">
        <Note status="warning">
          「输入命中（缓存）」和「输入未命中」是同一笔输入的两种计费 —— 命中部分按折扣价。
        </Note>
        <Note status="neutral">
          「其中 · 推理」是「输出」的一部分：输出 = 推理 + 非推理输出，推理不单独计价。
        </Note>
        {lines ? (
          <Note status="warning">
            金额按当前时段价估算，<strong>不是账单</strong> —— 高峰/空闲价差一倍，
            且判不了法定节假日（那天会按高峰估）。
          </Note>
        ) : null}
        {unpriced > 0 ? (
          <Note status="neutral">
            有 {unpriced} 个模型没配单价，金额里不含它们（不猜价，只显示 token）。
          </Note>
        ) : null}
      </ul>
    </>
  )
}
