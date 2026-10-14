/* ══════════════════════════════════════════════════════════════
   花费折算（A-展示 · 折算层）

   把「多少 token」换成「大概多少钱」。**全是纯函数**，不碰 IPC、不碰 UI。

   ★ 三条纪律（用户明确拍的板，改之前先问）：
     ① **不猜价**：查不到单价就返回 `null`，界面只显示 token、写「未配置单价」。
        宁可什么都不显示，也不给一个「看似精确的错数字」。
     ② **只按当前时刻估算**：`auto` 判的是**此刻**是高峰还是空闲，然后对**全部**
        token 用同一档。stats.json 的聚合桶**没有时刻**，所以逐笔精确分档做不到 ——
        这是估算，不是账单。界面上必须写明。
     ③ **推理不是独立计费桶**：它是 `completion` 的子集（上游 `reasoning_tokens`
        含在 `completion_tokens` 里，官方也不单列推理价）。所以这里的输入是
        `{ inMiss, inHit, out }` 三项，`out` 里已经含推理，**不要**再加一项。

   单价形状的唯一真相源在内核（`electron/core/pricing-defaults.cjs` 与
   `config-normalize-parts.cjs` 的 `normalizePricing`）；这里只消费，不另定义。
   ══════════════════════════════════════════════════════════════ */

import type { ModelPrice, PricingConfig } from '@/types/pricing'

/** 单价口径：元 / **百万** tokens（官方价页就是这个单位） */
const PER_MILLION = 1_000_000

export type PriceTierName = 'peak' | 'offPeak'

/**
 * 北京时间的**高峰**判定（DeepSeek 官方口径，见 pricing-defaults.cjs 顶部）。
 *
 * 高峰 = 周一至周五 09:00–12:00、14:00–18:00；其余（含周末）= 空闲。
 *
 * ⚠️ 两个认账的地方：
 *   · **法定节假日判不了**（没有日历表）→ 那天会被当成高峰，估出来的钱偏多；
 *   · 时区按**北京时间**硬算（+8），不跟随本机时区 —— 官方按时区定价，
 *     用户把系统时区调成别的，账单也不变（这个函数要跟着官方走）。
 */
export function isPeakTime(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const day = bj.getUTCDay() /* 0 = 周日 */
  if (day === 0 || day === 6) return false
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  /* 09:00–12:00 与 14:00–18:00，**左闭右开**（12:00 整、18:00 整都算空闲） */
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** 这次估算按哪一档（`auto` 看此刻；`peak` / `offPeak` 是用户钉死的） */
export function tierOf(pricing: PricingConfig | null, now: Date = new Date()): PriceTierName {
  const mode = pricing?.peakMode
  if (mode === 'peak') return 'peak'
  if (mode === 'offPeak') return 'offPeak'
  return isPeakTime(now) ? 'peak' : 'offPeak'
}

/** 一份价**三项齐全且是有限数**才可用（缺一项 → 整份不可用，不做「部分折算」） */
function isComplete(entry: unknown): entry is ModelPrice {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, { peak?: unknown; offPeak?: unknown }>
  return (['inMiss', 'inHit', 'out'] as const).every((key) => {
    const tier = e[key]
    return (
      Boolean(tier) &&
      typeof tier === 'object' &&
      Number.isFinite(Number(tier.peak)) &&
      Number.isFinite(Number(tier.offPeak))
    )
  })
}

/**
 * 查一个 (供应商, 模型) 的单价 —— **三级匹配**，查不到就 `null`。
 *
 *   ① 精确：`providers[providerId][model]`
 *      ★ 命中但**价不完整**（数据坏了）→ 直接 `null`，**不回退到别家的价**
 *        （拿另一个供应商的价格去顶，正是「看似精确的错数字」）；
 *   ② 唯一命中：`providerId` 对不上时（统计里 `byModel` **只存了模型名**，
 *      没有 providerId），在所有供应商里找这个模型名 —— **恰好一个**声明者才用；
 *      不完整的那份**也算声明者**（避免误用另一家同名的价）；
 *   ③ 其余（找不到 / 找到多个）→ `null`。
 *
 * ★ 为什么「多个一律 null」：同名模型在两个供应商下价格可能完全不同，
 *   挑一个等于编账单。两个供应商价恰好相同也照返回 `null` —— 规则简单、
 *   说得清；放宽成「同价可取」要引入深比较，不值得。
 */
export function priceOf(
  pricing: PricingConfig | null | undefined,
  providerId: string | undefined,
  model: string | undefined,
): ModelPrice | null {
  if (!pricing || typeof model !== 'string' || !model) return null
  const all = pricing.providers ?? {}

  /* ① 精确命中（含「命中但不完整 → 直接放弃」这条） */
  const exactTable = providerId ? all[providerId] : undefined
  if (exactTable && model in exactTable) {
    const entry = exactTable[model]
    return isComplete(entry) ? entry : null
  }

  /* ② 全库找同名模型：必须**恰好一个 supplier 声明了它**，且那份价完整。
        ★ 不完整的那份也**算一个声明者** —— 否则「A 有但不完整、B 完整」会被
          当成唯一命中而误用 B 的价（同「不猜」的初衷，宁可 null）。 */
  let owner: unknown
  let owners = 0
  for (const table of Object.values(all)) {
    if (!table || !(model in table)) continue
    owners += 1
    owner = table[model]
  }
  if (owners !== 1) return null
  return isComplete(owner) ? (owner as ModelPrice) : null
}

/** 折算要用的 token 三项 —— `out` **已含推理**，不要再单列一项 */
export interface TokenSplit {
  /** 输入 · 未命中缓存（= `prompt − cached`，**不要**用 `cacheMiss`：它会漏统计） */
  inMiss: number
  /** 输入 · 命中缓存 */
  inHit: number
  /** 输出（**含推理**） */
  out: number
}

export interface CostEstimate {
  inMiss: number
  inHit: number
  out: number
  /** 三项之和 */
  total: number
  /** 这次用的是哪一档 —— 界面要据此写「按当前时段估算」 */
  tier: PriceTierName
}

/**
 * 折算出金额（元）。
 *
 * @param tokens   `{ inMiss, inHit, out }`；缺字段 / 非数字一律当 0（老数据不 NaN）
 * @param price    `priceOf` 的结果；**不完整就返回 `null`**（不静默按 0 算 ——
 *                 那样会显示「¥0.00」，比不显示更误导）
 * @param pricing  取 `peakMode`；缺省当 `auto`
 * @param now      只在 `auto` 下用；传它才可测（默认此刻）
 *
 * ⚠️ 返回值是**估算**：`auto` 用的是「此刻」那一档，不是每笔调用各自的时刻。
 */
export function estimateCost(
  tokens: TokenSplit | null | undefined,
  price: ModelPrice | null | undefined,
  pricing?: PricingConfig | null,
  now: Date = new Date(),
): CostEstimate | null {
  if (!isComplete(price)) return null

  const tier = tierOf(pricing ?? null, now)
  const count = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const cost = (value: unknown, perMillion: { peak: number; offPeak: number }): number =>
    (count(value) / PER_MILLION) * Number(perMillion[tier])

  const inMiss = cost(tokens?.inMiss, price.inMiss)
  const inHit = cost(tokens?.inHit, price.inHit)
  const out = cost(tokens?.out, price.out)

  return { inMiss, inHit, out, total: inMiss + inHit + out, tier }
}
