/* ══════════════════════════════════════════════════════════════
   用量统计（token）

   从 `models-extra.ts` 抽出来的 —— 那边又贴到 300 行了。
   缝很清楚：**「花了多少」这一件事**（按天 / 按模型的桶 + 闸门状态），
   和会话、文件、终端那些没关系。内核对应 `electron/core/stats.cjs`
   与 `limits.cjs`。
   ══════════════════════════════════════════════════════════════ */

export interface UsageBucket {
  prompt: number
  completion: number
  total: number
  calls: number
  /** 命中 prompt 缓存的 token 数（命中部分便宜很多） */
  cached: number
}

/**
 * 用量闸此刻的**真实**状态（内核算好的，界面不自己判）。
 *
 * 判定只在内核 `limits.cjs` 的 `gateState()` 里做一处：日期口径、0 = 不限、
 * 日限优先，都那边说了算。界面自己再算一遍就会出现两份口径
 * （这个项目踩过：日期函数写了两份 → 闸门永远算成 0）。
 */
export interface LimitsGateState {
  enabled: boolean
  dailyTokens: number
  monthlyTokens: number
  onExceed: 'block' | 'warn'
  /** 今天已用的 token */
  today: number
  /** 本月已用的 token */
  month: number
  exceeded: boolean
  /** 超的是哪一道：日限还是月限（没超是 null） */
  level: 'day' | 'month' | null
  /**
   * 闸门**开着**，但每天 / 每月的上限都是 0 = 不限 —— 等于没开。
   *
   * ★ 这个字段存在的唯一理由：以前界面只显示「勾上了、两个框空着」，
   *   看着像在保护，实际一个请求都不拦（用户原话「看似可用但实际无法正常使用」）。
   */
  idle: boolean
}

export interface StatsSummary {
  since: number
  total: UsageBucket
  days: Array<UsageBucket & { day: string }>
  models: Array<UsageBucket & { model: string }>
  file: string
  /** 闸门状态。老版本内核不返回这个字段 —— 缺了就当「不知道」，界面不乱说话 */
  gate?: LimitsGateState
}
