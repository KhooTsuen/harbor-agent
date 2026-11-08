import type { UsageBucket } from '@/types/stats'
import type { UsageQueryResult } from '@/types/usage-query'
import { useConfigStore } from '@/stores/useConfigStore'
import { formatMoney } from '@/lib/format'
import { costLinesOf } from '../parts/CostBreakdown'
import { BalanceCard } from '../parts/BalanceCard'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 费用与余额 —— 三样东西**必须分开摆**

      ① 实际账单金额  服务商真的返回了金额才算。没有就说没有。
      ② 本地折算成本  用单价表 × token 推算的，**不是实际付款**。
      ③ 账户余额      还能用多少，不是已经花掉多少。

    ── 为什么不能合成一个「花了多少钱」──────────────────────────
    三者来源不同、含义不同、可信度不同。合成一个数之后：
      · 用户会拿估算当账单（差一倍很常见，高峰/空闲价不同）
      · 余额会被误读成「已消费」（它是剩余额度，方向相反）
    所以这里三块各自带标题和限定语，谁也不许代表谁。

    ── 为什么不在这里新增价格编辑器 ──────────────────────────────
    单价仍在 `config.json` 的 `pricing` 段。本阶段只做「如实分开显示」。
    ══════════════════════════════════════════════════════════════ */

interface Props {
  data: UsageQueryResult
}

/** 新账本的 byModel → 旧 `UsageBucket` 形状（只为复用 `costLinesOf`，口径不另写一套） */
function asBuckets(data: UsageQueryResult): Array<UsageBucket & { model: string }> {
  return Object.keys(data.byModel).map((model) => {
    const b = data.byModel[model]
    return {
      model,
      prompt: b.prompt,
      completion: b.completion,
      total: b.total,
      calls: b.requests,
      cached: b.cacheHit,
      reasoning: b.reasoning,
    }
  })
}

export function UsageCost({ data }: Props): React.ReactElement {
  const pricing = useConfigStore((s) => s.config?.pricing) ?? null
  const currency = pricing?.currency ?? 'CNY'

  /* ① 实际账单：只有服务商真返回金额时 `cost` 才是数字（内核保证否则为 null） */
  const billed = data.totals.cost
  const billedKnown = billed !== null && Number.isFinite(billed)

  /* ② 本地折算：复用既有实现，明确标注为估算 */
  const { lines, unpriced } = costLinesOf(asBuckets(data), pricing)
  const estimated = lines ? formatMoney(lines.total, currency) : null

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="三样来源不同，不能相互代表；没有真实金额就不显示金额">
        费用与余额
      </SectionTitle>

      <div className="grid gap-2 lg:grid-cols-2">
        {/* ① 实际账单 */}
        <div className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
          <p className="text-dense text-fg-primary">服务商实际账单金额</p>
          {billedKnown ? (
            <p className="mt-1 font-mono text-body text-fg-primary">
              {formatMoney(billed as number, currency)}
            </p>
          ) : (
            <p className="mt-1 text-body text-fg-tertiary">没有</p>
          )}
          <p className="mt-1 text-2xs leading-relaxed text-fg-tertiary">
            {billedKnown
              ? '这是服务商在上报 usage 时一并返回的金额，属于**实际计费**口径。'
              : '你的服务商没有在响应里返回金额，所以这里**没有**实际支出数字 —— 不会用单价表推算冒充。真实账单请到服务商后台看。'}
          </p>
        </div>

        {/* ② 本地折算 */}
        <div className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
          <p className="text-dense text-fg-primary">
            本地折算成本
            <span className="ml-1.5 rounded-sm border border-line-subtle px-1 py-0.5 text-[10px] text-fg-tertiary">
              估算
            </span>
          </p>
          {estimated ? (
            <p className="mt-1 font-mono text-body text-fg-secondary">{estimated}</p>
          ) : (
            <p className="mt-1 text-body text-fg-tertiary">未配置单价</p>
          )}
          <p className="mt-1 text-2xs leading-relaxed text-fg-tertiary">
            {estimated
              ? '按 config.json 里的单价 × 已记录的 token 推算，**不是账单、不等于实际付款**；高峰/空闲价差可能到一倍。'
              : '配置里没有单价表，所以只显示 token，不猜金额。'}
            {unpriced > 0 ? ` 另有 ${unpriced} 个模型没配单价，不含在这个数里。` : ''}
          </p>
        </div>
      </div>

      {/* ③ 账户余额：已有组件，它是「剩余额度」，与上面两块方向不同 */}
      <div className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
        <p className="mb-1 text-dense text-fg-primary">
          账户余额
          <span className="ml-1.5 text-2xs font-normal text-fg-tertiary">
            剩余额度，不是已消费金额
          </span>
        </p>
        <BalanceCard />
      </div>
    </div>
  )
}
