import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   用量闸改配置时的**合并口径**

   踩过的坑（和「选了模型却不生效」同一类）：两个上限输入框先后失焦，
   各自把手里的 `limits` 快照整个交上去 —— 后交的那份快照里另一个字段
   还是旧值，于是**先填的那个被悄悄写回去了**。用户看到的是
   「填了、也存了，回头一看又空着」。

   所以约定：调用方**只交自己改的字段**，store 按最新配置合。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  pushed: [] as Array<Record<string, unknown>>,
  config: {
    limits: { enabled: true, dailyTokens: 0, monthlyTokens: 0, onExceed: 'block' as const },
  },
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    isElectron: true,
    loadConfig: async () => h.config,
    /*
     * 假的内核：把 patch 原样合并回来（真内核 `config.cjs` 的 patch 也是深合并），
     * 并记下**交上来的那份 patch** —— 断言就看它。
     */
    pushConfig: async (patch: Record<string, unknown>) => {
      h.pushed.push(patch)
      h.config = { ...h.config, ...patch } as typeof h.config
      return h.config
    },
  }
})

import { useConfigStore } from '@/stores/useConfigStore'

describe('patchLimits 的合并', () => {
  beforeEach(() => {
    h.pushed = []
    h.config.limits = { enabled: true, dailyTokens: 0, monthlyTokens: 0, onExceed: 'block' }
    useConfigStore.setState({ config: null })
  })

  it('★ 只交要改的字段，另一个字段由最新配置补上（不会被旧快照写回）', async () => {
    useConfigStore.setState({ config: h.config as never })

    await useConfigStore.getState().patchLimits({ dailyTokens: 2_000_000 })
    await useConfigStore.getState().patchLimits({ monthlyTokens: 30_000_000 })

    /* 交上来的必须是合成后的完整对象，且第二次不会把每天上限抹掉 */
    expect(h.pushed[0]).toEqual({
      limits: { enabled: true, dailyTokens: 2_000_000, monthlyTokens: 0, onExceed: 'block' },
    })
    expect(h.pushed[1]).toEqual({
      limits: {
        enabled: true,
        dailyTokens: 2_000_000,
        monthlyTokens: 30_000_000,
        onExceed: 'block',
      },
    })
  })

  it('配置还没读回来时也不炸（只是合不上旧值）', async () => {
    await useConfigStore.getState().patchLimits({ enabled: false })
    expect(h.pushed[0]).toEqual({ limits: { enabled: false } })
  })
})
