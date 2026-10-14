/* ══════════════════════════════════════════════════════════════
   单价（A-展示）

   只用于**估算花费**，不参与任何拦截 —— 用量闸按 token 数算，不看金额。

   从 models.ts 抽出来的（那边 300 行打不住）。真相源在内核：
     · 默认值  `electron/core/pricing-defaults.cjs`
     · 归一化  `electron/core/config-normalize-parts.cjs` 的 `normalizePricing`
   两边**必须同形**，改一处就要改另一处。
   ══════════════════════════════════════════════════════════════ */

/** 一项单价：高峰 / 空闲两档（内核已把「写单个数」归一成两档同值，这里只认这一种） */
export interface PriceTier {
  peak: number
  offPeak: number
}

/** 一个模型的三项价（元 / 百万 tokens）。三项**必须齐全**才可用（缺 → 整份不可用） */
export interface ModelPrice {
  /** 输入 · 未命中缓存 */
  inMiss: PriceTier
  /** 输入 · 命中缓存 */
  inHit: PriceTier
  /** 输出（含推理） */
  out: PriceTier
}

export interface PricingConfig {
  /** 货币代码，喂 `Intl.NumberFormat` */
  currency: string
  /** 单价单位：固定 perMillionTokens（元/百万 tokens） */
  unit: 'perMillionTokens'
  /** 双档怎么取：auto = 按当前时刻判 / peak = 一律高峰 / offPeak = 一律空闲 */
  peakMode: 'auto' | 'peak' | 'offPeak'
  /** `providerId → model → 三项价` */
  providers: Record<string, Record<string, ModelPrice>>
}
