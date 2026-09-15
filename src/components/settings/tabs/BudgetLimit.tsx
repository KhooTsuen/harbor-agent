import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useConfigStore } from '@/stores/useConfigStore'
import { Field } from '@/components/ui/Field'

/* ══════════════════════════════════════════════════════════════
   用量闸（预算）

   放在「设置 → 用量」里，因为这是看用量时最自然会想改的东西 ——
   「这个月花了这么多…那把上限调一下」。

   ⚠️ 只按 **token 数**，不做金额。金额要维护一张「每个模型多少钱」的价目表，
   那个表会过期；而且走中转站时各家后端计价都不一样。token 数是上游直接给的、
   本来就在记的，**准而且不用维护**。

   默认**关着** —— 是个保护装置，不该在用户没要求的时候拦住他。
   ══════════════════════════════════════════════════════════════ */

const n = (v: number): string => v.toLocaleString('zh-CN')

export function BudgetLimit(): React.ReactElement | null {
  const config = useConfigStore((s) => s.config)
  const patchLimits = useConfigStore((s) => s.patchLimits)

  const limits = config?.limits
  /* 输入框要能打「1」这种中间状态，所以本地存草稿，失焦才写回配置 */
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')

  useEffect(() => {
    setDaily(limits?.dailyTokens ? String(limits.dailyTokens) : '')
    setMonthly(limits?.monthlyTokens ? String(limits.monthlyTokens) : '')
  }, [limits?.dailyTokens, limits?.monthlyTokens])

  if (!config || !limits) return null

  function commit(key: 'dailyTokens' | 'monthlyTokens', text: string): void {
    const value = Math.max(0, Math.round(Number(text.replace(/[^\d]/g, '')) || 0))
    void patchLimits({ ...limits, [key]: value })
  }

  return (
    <div className="py-2">
      <label className="flex items-start gap-2 text-dense text-fg-primary">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={limits.enabled}
          onChange={(e) => void patchLimits({ ...limits, enabled: e.target.checked })}
        />
        <span>
          用量超过上限就停下
          <span className="ml-1.5 text-2xs text-fg-tertiary">
            （在调模型之前查一次账，这是唯一能真正省钱的位置）
          </span>
        </span>
      </label>

      {limits.enabled ? (
        <div className="mt-2.5 flex flex-col gap-2.5 pl-5">
          <div className="grid grid-cols-2 gap-2">
            <label className="acrylic-card block rounded-base px-3.5 py-3">
              <span className="mb-1 block text-2xs text-fg-tertiary">
                每天上限（token，0 = 不限）
              </span>
              <Field
                value={daily}
                onChange={setDaily}
                onBlur={() => commit('dailyTokens', daily)}
                placeholder="比如 2000000"
                inputMode="numeric"
                spellCheck={false}
              />
            </label>
            <label className="acrylic-card block rounded-base px-3.5 py-3">
              <span className="mb-1 block text-2xs text-fg-tertiary">
                每月上限（token，0 = 不限）
              </span>
              <Field
                value={monthly}
                onChange={setMonthly}
                onBlur={() => commit('monthlyTokens', monthly)}
                placeholder="比如 30000000"
                inputMode="numeric"
                spellCheck={false}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-dense text-fg-primary">
            <span className="text-2xs text-fg-tertiary">超了之后</span>
            <button
              type="button"
              onClick={() =>
                void patchLimits({
                  ...limits,
                  onExceed: limits.onExceed === 'block' ? 'warn' : 'block',
                })
              }
              className="rounded-small border border-line-subtle bg-bg-raised px-2 py-0.5 text-2xs text-fg-primary transition-colors hover:border-line-focus"
            >
              {limits.onExceed === 'block' ? '拦住（报错）' : '只提示，继续跑'}
            </button>
          </label>

          <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-fg-tertiary">
            <ShieldAlert size={12} className="mt-0.5 shrink-0" />
            <span>
              上限是按**上游返回的** token 数算的（就是上面那些数字），不是本地估算。
              统计不到用量的站点，这里也就拦不住 —— 那种情况要靠你自己盯。
              {limits.dailyTokens > 0 || limits.monthlyTokens > 0 ? (
                <>
                  <br />
                  当前设定：
                  {limits.dailyTokens > 0 ? ` 每天 ${n(limits.dailyTokens)}` : ' 每天不限'}
                  {limits.monthlyTokens > 0 ? ` · 每月 ${n(limits.monthlyTokens)}` : ' · 每月不限'}
                </>
              ) : null}
            </span>
          </p>
        </div>
      ) : null}
    </div>
  )
}
