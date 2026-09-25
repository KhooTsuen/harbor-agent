import { useConfigStore } from '@/stores/useConfigStore'
import type { CapabilityDim, ModelCapabilities, ModelCapabilityInfo } from '@/types/backend'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   供应商卡片里的「每个模型会什么」

   紧凑：一个模型一行，只写**有用**的几项。
   三条规矩：
     · `false`（明确不支持）和 `null`（未知）**画得不一样** —— 前者写「不支持」，
       后者写「未知」。把未知画成不支持等于我们替用户猜了。
     · 「不支持」只标 tool_call / vision 两项 —— 这两个是**真会让调用失败**的，
       其余的不支持只是「用不上」，铺出来只会变噪音。
     · 顶部和底部都写明这是**声明**不是探测（那句话来自内核，不在这儿另写一句）。
   ══════════════════════════════════════════════════════════════ */

/** 值得显示的布尔维度（上下文容量单独显示） */
const SHOW: CapabilityDim[] = [
  'tool_call',
  'vision',
  'streaming',
  'structured_output',
  'reasoning',
  'search',
  'attachments',
]

/** 明确不支持时必须写出来的两项 */
const MUST_FLAG: CapabilityDim[] = ['tool_call', 'vision']

/** 65536 → 66K、1048576 → 1.0M（界面上的约数，精确值在 tooltip 里） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}K`
}

export interface ModelCapabilityListProps {
  models: readonly string[]
}

export function ModelCapabilityList({ models }: ModelCapabilityListProps) {
  const matrix = useConfigStore((s) => s.config?.capabilities)
  if (!matrix || models.length === 0) return null

  return (
    <div className="mt-2 border-t border-line-hairline pt-2">
      <p className="mb-1 flex items-center gap-1 text-2xs text-fg-tertiary">
        模型能力
        <span className={cn('font-medium', STATUS_CLASS.warning.text)}>（声明，不是实测）</span>
      </p>
      <div className="flex flex-col gap-1">
        {models.map((model) => (
          <ModelRow key={model} model={model} info={matrix.models[model]} labels={matrix.labels} />
        ))}
      </div>
      <p className="mt-1.5 text-dense leading-relaxed text-fg-tertiary/80" title={matrix.note}>
        {matrix.note}
      </p>
      <p className="text-dense leading-relaxed text-fg-tertiary/80">
        预设不对？在 data/config.json 里给这个模型加 modelCapabilities 就能覆盖（手填优先于预设）
      </p>
    </div>
  )
}

function ModelRow({
  model,
  info,
  labels,
}: {
  model: string
  info?: ModelCapabilityInfo
  labels: Record<CapabilityDim, string>
}) {
  const caps: ModelCapabilities | undefined = info?.caps
  /* 矩阵是按 provider.models 算的，理论上一定有；没有就一个字都不说，别编 */
  if (!caps) return null

  const known = Object.values(caps).some((value) => value !== null)
  const handFilled = Object.values(info?.source ?? {}).some((from) => from === 'override')

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-mono text-2xs text-fg-secondary" title={info?.presetNote || model}>
        {model}
      </span>

      {known ? (
        SHOW.map((dim) => {
          const value = caps[dim]
          if (value === true) {
            return (
              <span key={dim} className="text-2xs text-fg-tertiary">
                ✓{labels[dim]}
              </span>
            )
          }
          if (value === false && MUST_FLAG.includes(dim)) {
            return (
              <span key={dim} className={cn('text-2xs', STATUS_CLASS.warning.text)}>
                ✗{labels[dim]}（不支持）
              </span>
            )
          }
          return null
        })
      ) : (
        <span className="text-2xs text-fg-tertiary/80">能力未知 —— 没有这个模型的预设</span>
      )}

      {caps.context_window !== null ? (
        <span className="text-2xs text-fg-tertiary" title={`${caps.context_window} tokens`}>
          上下文约 {formatTokens(caps.context_window)}
        </span>
      ) : null}
      {handFilled ? <span className="text-2xs text-fg-tertiary">· 有手填</span> : null}
    </div>
  )
}
