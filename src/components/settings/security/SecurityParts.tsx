import { useState } from 'react'
import type { RiskVerdict } from '@/types/backend'
import type { AppConfig, PolicyAction } from '@/types/models'
import { Button } from '@/components/ui/Button'
import { classifyCommand } from '@/lib/safetyApi'
import { Row } from '../parts'
import { LEVEL_COLOR, LEVEL_FULL_LABEL, POLICY_OPTIONS } from './meta'

/* ══════════════════════════════════════════════════════════════
   设置 → 安全：几个只服务这一页的小部件

   从 SecurityTab.tsx 拆出来的（那边贴到 300 行红线）。
   抽的判据是「自成一体的状态 / 无状态的小控件」—— 它们和页面其余部分没有交集。
   ══════════════════════════════════════════════════════════════ */

/**
 * 「试算一条命令」那一行。
 *
 * 探针的输入与结果是它自己的状态（页面别处用不到），所以连同 state 一起搬过来 ——
 * 留在页面里的话，每次改这里都要碰那个已经很长的主组件。
 */
export function RiskProbe() {
  const [probe, setProbe] = useState('')
  const [probeResult, setProbeResult] = useState<{ verdict: RiskVerdict; action: string } | null>(
    null,
  )

  return (
    <Row label="试算一条命令" hint="输入命令看它会被判成什么等级（不执行）">
      <div className="flex flex-col gap-2">
        <input
          value={probe}
          onChange={(e) => setProbe(e.target.value)}
          placeholder="例如：rm -rf ./build"
          spellCheck={false}
          className="w-full rounded-sm border border-line-subtle bg-bg-input px-2 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void classifyCommand(probe).then(setProbeResult)}
          >
            试算
          </Button>
          {probeResult ? (
            <span className="text-2xs">
              <span style={{ color: LEVEL_COLOR[probeResult.verdict.level] }}>
                {LEVEL_FULL_LABEL[probeResult.verdict.level]}
              </span>
              <span className="text-fg-tertiary">
                {' '}
                · 处置：
                {POLICY_OPTIONS.find((p) => p.value === probeResult.action)?.label ??
                  probeResult.action}
                {probeResult.verdict.reasons.length > 0
                  ? ` · ${probeResult.verdict.reasons.join('；')}`
                  : ''}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </Row>
  )
}

/** 补全三个键 —— patch 是浅合并，缺的键会把类型搞成可选 */
export function fullPolicy(
  policy?: Partial<AppConfig['tools']['shellPolicy']>,
): AppConfig['tools']['shellPolicy'] {
  return { medium: 'ask', high: 'ask', critical: 'block', ...policy }
}

export function PolicySelect({
  value,
  onChange,
}: {
  value: PolicyAction
  onChange: (value: PolicyAction) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as PolicyAction)}
      className="rounded-sm border border-line-subtle bg-bg-input px-2 py-1 text-dense text-fg-primary focus:border-line-focus focus:outline-none"
    >
      {POLICY_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
