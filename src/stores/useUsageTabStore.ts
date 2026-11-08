import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
    「模型用量」页的筛选状态 —— 住在组件外

    ── 为什么不用组件内 state ────────────────────────────────────
    用户点了「最近 90 天 → 筛某个模型 → 回聊天 → 再进来」时，筛选必须还在。
    组件内 state 一卸载就归零，等于每次进来都要重设一遍。这和模型页
    （`useModelsTabStore`）、权限页（`useAccessTabStore`）是同一个范式。

    ── 范围只存「天数」不存时间戳 ────────────────────────────────
    存 `rangeDays` 而不是 `from/to`：跨天开着应用时，存死的时间戳会让
    「最近 30 天」慢慢变成「31 天前到昨天」。每次查询现算边界。
    ══════════════════════════════════════════════════════════════ */

/** 时间范围档位（值 = 天数；`0` = 全部历史） */
export const USAGE_RANGES = [
  { days: 7, label: '最近 7 天' },
  { days: 30, label: '最近 30 天' },
  { days: 90, label: '最近 90 天' },
  { days: 365, label: '最近一年' },
  { days: 0, label: '全部' },
] as const

export type UsageRangeDays = (typeof USAGE_RANGES)[number]['days']

const VALID_DAYS: readonly number[] = USAGE_RANGES.map((r) => r.days)

export function isUsageRangeDays(value: unknown): value is UsageRangeDays {
  return typeof value === 'number' && VALID_DAYS.includes(value)
}

interface UsageTabState {
  /** 时间范围（天；0 = 全部） */
  rangeDays: UsageRangeDays
  /** 供应商筛选（空 = 不筛） */
  providerId: string
  /** 模型筛选（空 = 不筛） */
  model: string
  /** 任务筛选（空 = 不筛） */
  taskId: string
  /** 热力图点中的那天（`YYYY-MM-DD`，空 = 没选）—— 联动下方明细 */
  day: string
  setRangeDays: (days: UsageRangeDays) => void
  /**
   * 一次性设齐三个等值筛选。
   * ★ 换供应商时必须把模型清掉：不同供应商的模型不通用，留着会筛出空结果
   *   （用户看到「0 条」但不知道为什么）。
   */
  setFilters: (patch: { providerId?: string; model?: string; taskId?: string }) => void
  /** 点热力图某天（再点一次取消） */
  pickDay: (day: string) => void
  /** 清空全部筛选（含日期） */
  clearFilters: () => void
}

export const useUsageTabStore = create<UsageTabState>((set) => ({
  rangeDays: 30,
  providerId: '',
  model: '',
  taskId: '',
  day: '',
  setRangeDays: (rangeDays) => set({ rangeDays, day: '' }),
  setFilters: (patch) =>
    set((prev) => {
      const next = { ...prev, ...patch }
      if (patch.providerId !== undefined && patch.providerId !== prev.providerId) next.model = ''
      /* 换任何等值筛选都清掉「选中的那天」：日期 + 模型同时生效时结果是子集，
         用户容易以为「这天只有这么点」 */
      next.day = ''
      return next
    }),
  pickDay: (day) => set((prev) => ({ day: prev.day === day ? '' : day })),
  clearFilters: () => set({ providerId: '', model: '', taskId: '', day: '' }),
}))
