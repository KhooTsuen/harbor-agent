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
  /**
   * 思考（reasoning）token（CE-019）—— 属于 `completion`（推理按输出计费），
   * 所以「输出 = 思考 + 非思考输出」，**不是并列两桶**。
   * 内核保证它一定是数字（老记录按 0 补，见 `core/stats.cjs` 的 `load`）—— 界面不用再防 NaN。
   */
  reasoning: number
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

/* ══════════════════════════════════════════════════════════════
   账户余额（DeepSeek 专有）

   ★ **数字全是字符串** —— 官方 schema 就是 string（`"total_balance": "110.00"`）。
     这里不做 `Number()`：接口少给一个字段时就变成 `undefined + 数字 = NaN`，
     界面上会显示「余额 NaN」。原样带过来，格式化和「有没有值」的判断都在界面做。

   ★ 失败是**预期结果之一**（网络不通 / Key 无效 / 接口变更），所以整条是
     `ok: false + error` 而不是抛异常 —— 界面据此显示「查询失败」。
   ══════════════════════════════════════════════════════════════ */

/** 一种货币的余额（余额接口按货币分行，通常只有一条） */
export interface BalanceInfo {
  /** CNY / USD */
  currency: string
  /** 总可用余额（赠金 + 充值），字符串 */
  total: string
  /** 未过期的赠金余额 */
  granted: string
  /** 充值余额 */
  toppedUp: string
}

export interface BalanceResult {
  ok: boolean
  /** 当前账户是否还有余额可供调用（`is_available`） */
  available?: boolean
  infos?: BalanceInfo[]
  /** 内核**查询完成**的时刻（ms）。注意不是「上次点击」的时间 */
  at?: number
  error?: string
}
