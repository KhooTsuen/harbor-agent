import { useEffect, useRef, useState } from 'react'
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

/** 输入框里的文字 → token 数（只留数字，空 = 0 = 不限） */
const toTokens = (text: string): number =>
  Math.max(0, Math.round(Number(text.replace(/[^\d]/g, '')) || 0))

export function BudgetLimit(): React.ReactElement | null {
  const config = useConfigStore((s) => s.config)
  const patchLimits = useConfigStore((s) => s.patchLimits)

  const limits = config?.limits
  /* 输入框要能打「1」这种中间状态，所以本地存草稿 */
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  /*
   * ★ 写回配置**不靠失焦**（真机踩到的）：
   *   原来只挂 onBlur —— 填完直接点 X / 按 Esc 关面板时，blur 不一定来
   *   （设置面板是隐藏不是卸载），那个值就**永远不提交**。
   *   用户看到的是「填了、看着也在，重新打开又空了」—— 和这个月栽的
   *   「写了不生效」是同一类病，所以改成「改一下就排一次提交」，失焦只是提前触发。
   */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /* 草稿的镜像：卸载那一刻的闭包读不到最新 state，只能靠 ref */
  const draft = useRef({ daily: '', monthly: '' })

  useEffect(() => {
    setDaily(limits?.dailyTokens ? String(limits.dailyTokens) : '')
    setMonthly(limits?.monthlyTokens ? String(limits.monthlyTokens) : '')
  }, [limits?.dailyTokens, limits?.monthlyTokens])

  useEffect(() => {
    const slot = timer
    return () => {
      clearTimeout(slot.current)
      /* 防抖还没到点就把面板关了 → 关之前把草稿补交一次 */
      const { daily: d, monthly: m } = draft.current
      if (d) void patchLimits({ dailyTokens: toTokens(d) })
      if (m) void patchLimits({ monthlyTokens: toTokens(m) })
    }
    /* 只在卸载时跑：草稿从 ref 读，patchLimits 是稳定的 store 动作 */
  }, [patchLimits])

  if (!config || !limits) return null

  function commit(key: 'dailyTokens' | 'monthlyTokens', text: string): void {
    const value = toTokens(text)
    /*
     * **只交这一个字段**：另一个字段交给 store 按最新配置合进来。
     * 以前是整个 `limits` 交上去的，两个框先后失焦时会拿旧快照把先填的写回去。
     */
    void patchLimits(key === 'dailyTokens' ? { dailyTokens: value } : { monthlyTokens: value })
  }

  /** 改一下就排一次提交（防抖）；失焦 / 关面板都只是「提前触发」 */
  function schedule(key: 'dailyTokens' | 'monthlyTokens', text: string): void {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(key, text), 700)
  }

  function edit(key: 'dailyTokens' | 'monthlyTokens', text: string): void {
    draft.current[key === 'dailyTokens' ? 'daily' : 'monthly'] = text
    if (key === 'dailyTokens') setDaily(text)
    else setMonthly(text)
    schedule(key, text)
  }

  return (
    <div className="py-2">
      <label className="flex items-start gap-2 text-dense text-fg-primary">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={limits.enabled}
          onChange={(e) => void patchLimits({ enabled: e.target.checked })}
        />
        <span>
          用量超过上限就停下
          <span className="ml-1.5 text-dense text-fg-tertiary">
            （在调模型之前查一次账，这是唯一能真正省钱的位置）
          </span>
        </span>
      </label>

      {limits.enabled ? (
        <div className="mt-2.5 flex flex-col gap-2.5 pl-5">
          <div className="grid grid-cols-2 gap-2">
            <label className="acrylic-card rounded-base block px-3.5 py-3">
              <span className="mb-1 block text-2xs text-fg-tertiary">
                每天上限（token，0 = 不限）
              </span>
              <Field
                value={daily}
                onChange={(value) => edit('dailyTokens', value)}
                onBlur={() => commit('dailyTokens', daily)}
                placeholder="比如 2000000"
                inputMode="numeric"
                spellCheck={false}
              />
            </label>
            <label className="acrylic-card rounded-base block px-3.5 py-3">
              <span className="mb-1 block text-2xs text-fg-tertiary">
                每月上限（token，0 = 不限）
              </span>
              <Field
                value={monthly}
                onChange={(value) => edit('monthlyTokens', value)}
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
