import { useEffect } from 'react'
import { useConfigStore } from '@/stores/useConfigStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   该不该弹首次启动引导

   从 App.tsx 抽出来的 —— 那段判定加注释有二十多行，放在 App 里
   把布局代码挤得看不见了。

   三种情况要弹：
     · URL 上明确带了 ?onboarding（调试用，随时能看）
     · 真后端 + 从来没走完引导
     · 真后端 + 走完了但**一个能用的供应商都没有**（换了机器、拷了别人的
       配置都会这样 —— 界面上什么都不提示的话，用户会以为软件坏了）
   ══════════════════════════════════════════════════════════════ */

export function useOnboardingGate(): boolean {
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)

  const forced =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('onboarding')

  /* apiKey 现在是掩码，配没配要看 hasKey */
  const hasUsableProvider = config?.providers.some((p) => p.hasKey) ?? false
  const needsOnboarding = Boolean(
    config &&
    !config.general.onboardingDismissed &&
    (!config.general.onboarded || !hasUsableProvider),
  )

  useEffect(() => {
    /* 老用户（已填过 Key）不再打扰，顺手补标记 */
    if (!config || config.general.onboarded) return
    if (config.providers.some((p) => p.hasKey)) {
      void patchGeneral({ onboarded: true, onboardingDismissed: true })
    }
  }, [config, patchGeneral])

  return forced || (useRealBackend && needsOnboarding)
}
