import { formatCount } from '@/lib/format'

/* ══════════════════════════════════════════════════════════════
   用量页的一格数字卡

   从 `UsageTab.tsx` 搬出来的（那边加了「花费构成」就顶到 300 行）。
   搬的理由：**两个地方都要用同一个样子** —— 用量那 5 格、花费构成那 4 格，
   各写一份早晚会漂（这个项目在状态色上已经栽过一次）。

   `money` 是可选的：查不到单价时**这一格不显示金额**（宁可少一行，
   也不拿别的模型的价猜一个「看着精确的错数字」）。
   ══════════════════════════════════════════════════════════════ */

export function StatCard({
  label,
  value,
  hint,
  money,
}: {
  label: string
  value: number
  hint?: string
  /** 折算金额的展示串（由调用方用 `formatMoney` 备好）。`null` / 不传 = 不显示 */
  money?: string | null
}) {
  return (
    <div className="rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2.5">
      <div className="text-2xs text-fg-tertiary">{label}</div>
      <div className="mt-0.5 font-mono text-lg leading-tight text-fg-primary">
        {formatCount(value)}
      </div>
      {money ? <div className="mt-0.5 font-mono text-dense text-fg-primary">{money}</div> : null}
      {hint ? <div className="mt-0.5 text-dense text-fg-tertiary">{hint}</div> : null}
    </div>
  )
}
