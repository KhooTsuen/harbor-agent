/**
 * 单价的**内置默认值**（A-展示 · 配置层）
 *
 * 从 `config-defaults.cjs` 拆出来的 —— 那边 292 行，塞下两个模型的价目表就过线了。
 * 拆的口子就在这儿：**这是价目表，不是逻辑**（同类先例：`config-mcp-env.cjs`）。
 *
 * ── 来源（官方文档，不是记忆）──────────────────────────────────
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 读取日期 2026-10-15。原文口径：**元 / 百万 tokens**。
 *
 * ── 为什么是双档 {peak, offPeak} ──────────────────────────────
 * DeepSeek 官方是**分时段定价**：高峰时段是空闲时段的 2 倍。
 *   · 高峰 = 北京时间周一至周五（**不含法定节假日**）9:00–12:00、14:00–18:00
 *   · 其余时段（含周末、法定节假日全天）= 空闲
 * 硬编码一个数必然错一半，所以结构上就必须留两档。
 *
 * ── ⚠️ 只列官方价页上**明确写着**的两个模型 ────────────────────
 * `deepseek-flash` / `deepseek-v4-pro`。老模型名（`deepseek-chat` /
 * `deepseek-reasoner`）**故意不在这里编价** —— 官方价页已不再列它们，
 * 照老印象填一个数就是「看似精确的错数字」（用户明确禁止）。
 * 真有人配着老名字，`priceOf` 会返回 `null` → 界面只显示 token、
 * 写「未配置单价」，让他自己去 config.json 补 —— 这比猜一个价诚实。
 *
 * ── 这个对象是「默认值」，不是「真相」────────────────────────
 * 用户可以在 `config.json` 的 `pricing` 段里覆盖（含只覆盖一部分 ——
 * 归一化层会深合并）。官方随时可能调价，**改价就改这里**。
 */

const PRICING_DEFAULTS = {
  /** 喂 `Intl.NumberFormat` 的货币代码 */
  currency: 'CNY',
  /** 单价单位，**固定** perMillionTokens（官方口径就是「元/百万 tokens」） */
  unit: 'perMillionTokens',
  /**
   * 双档怎么取：
   *   auto    = 按**查询那一刻**判高峰/空闲（默认）
   *   peak    = 一律按高峰价
   *   offPeak = 一律按空闲价
   * ⚠️ auto 判不了法定节假日（没有日历表），那天会把空闲当高峰 —— 界面上要认账。
   */
  peakMode: 'auto',
  /** 每项是 `{ peak, offPeak }`；也接受写**单个数**（= 不分档，归一化层会补成同值） */
  providers: {
    deepseek: {
      'deepseek-flash': {
        inMiss: { peak: 2, offPeak: 1 },
        inHit: { peak: 0.04, offPeak: 0.02 },
        out: { peak: 8, offPeak: 4 },
      },
      'deepseek-v4-pro': {
        inMiss: { peak: 9, offPeak: 4.5 },
        inHit: { peak: 0.3, offPeak: 0.15 },
        out: { peak: 27, offPeak: 13.5 },
      },
    },
  },
}

module.exports = { PRICING_DEFAULTS }
