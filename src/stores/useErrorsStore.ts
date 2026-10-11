import { create } from 'zustand'
import type { ErrorListResult } from '@/types/errors'
import { listErrors } from '@/lib/errorsApi'
import { countUnreadSevere, worstUnreadSeverity } from '@/lib/errorSignal'

/* ══════════════════════════════════════════════════════════════
   「错误」清单的**唯一**抓取入口（Phase 1 · A1）

   为什么把抓取收到 store 里：右栏「错误」标签和它的角标（RightTabs /
   AppTitleBar）要的是**同一份数据**。面板自己拉一份、角标再拉一份，就是
   两套数据、两次读盘 —— 迟早对不上。这里一处抓、多处读。

   ── 成本与节流（规范要求先核实）──────────────────────────────
   数据源：内核 `error:list`（`electron/core/error-reader.cjs`）→ 读
   `data/errors/*.jsonl`，只读、按天窗 + limit 兜底，一天几行，很轻。
   **没有推送事件**（加推送要动 IPC 契约，本轮不做），所以只能按
   「事件触发」抓：见 `useErrorSignal`（挂载 / 窗口重新可见 / 一轮跑完）。
   **没有任何定时器** —— 不引入轮询。

   ── 两个时间戳，别混 ─────────────────────────────────────────
     · `ackAt`   —— 上次「已读」的时刻（用户打开错误标签时更新）
     · `unreadSevere` —— lastSeen 晚于 ackAt 的严重错误条数
   读取失败（ok:false）**不清角标、也不造新角标** —— 把「读不出来」
   显示成「一切正常」是最误导人的一种显示（ErrorsPanel 的老规矩）。
   ══════════════════════════════════════════════════════════════ */

interface ErrorsState {
  /** 最近一次抓取结果（面板直接读它，不再自己拉） */
  snapshot: ErrorListResult | null
  loading: boolean
  /**
   * 上次「已读」的时间戳。首次成功抓取时置为**当时** —— 之前积压的历史
   * 错误不算「新」，否则一装上就永远挂着角标，反而变成噪音。
   */
  ackAt: number
  /** 自 ackAt 之后新出现的严重错误条数（= 角标数字） */
  unreadSevere: number
  /** 这些未读里最严重的一级（角标颜色用） */
  worstUnread: 'P0' | 'P1' | null
  /** 抓一次；days 由调用方给（面板有 7/30 天切换，默认 7） */
  refresh: (days?: number) => Promise<void>
  /** 用户看过错误清单了 → 只把「未读」清零，不动错误数据本身 */
  acknowledge: () => void
}

export const useErrorsStore = create<ErrorsState>((set) => ({
  snapshot: null,
  loading: false,
  ackAt: 0,
  unreadSevere: 0,
  worstUnread: null,

  refresh: async (days = 7) => {
    set({ loading: true })
    const result = await listErrors({ days })
    set((state) => {
      /* 读失败：保留既有角标与快照，只是记下这次结果 —— 不假装没有错误 */
      if (!result.ok) return { snapshot: result, loading: false }
      /* 首次成功：把「已读线」拉到当前时刻（历史错误不算新） */
      const ackAt = state.ackAt > 0 ? state.ackAt : Date.now()
      return {
        snapshot: result,
        loading: false,
        ackAt,
        unreadSevere: countUnreadSevere(result.entries, ackAt),
        worstUnread: worstUnreadSeverity(result.entries, ackAt) as 'P0' | 'P1' | null,
      }
    })
  },

  acknowledge: () => set({ ackAt: Date.now(), unreadSevere: 0, worstUnread: null }),
}))
