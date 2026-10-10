/**
 * 本轮上下文的「基准」（token）—— 内核侧唯一的算法。
 *
 * 2026-10-11：以前 `loop-prompt.cjs` 直接把 `config.context.baseTokens`（默认 16384）
 * 当基准，**跟模型的真实上下文窗口完全脱钩** —— 用户把模型换成 1M 窗口的
 * DeepSeek V4，发出去的对话层还是 16384×3×30% = 14745 字符，等于窗口白给。
 *
 * 现在口径与渲染层的压缩提示线**完全同一套**（`src/stores/thread/compact.ts`
 * 的 `resolveLimit`）：分母 = `min(模型窗口 × 80%, 用户上限)`，窗口未知才退回基准常量。
 * 两套各算各的后果是用户会看到「圈才到 50%，它却自己压了」那种自相矛盾（12c）。
 *
 * `config.context.baseTokens`：**0 = 跟随窗口（默认）**；显式值 = 用户钉死的上限（刹车，
 * 不因为窗口大就绕过）。窗口未知且本值为 0 → 退回 `DEFAULT_CONTEXT_TOKENS`
 * （与渲染层 `CONTEXT_BASE_TOKENS` 同值，漂移由测试盯着）。
 *
 * ⚠️ 这里全是**声明**算出来的窗口，不是探测（见 `provider-capabilities.cjs` 文件头）。
 */
const providerCaps = require('./provider-capabilities.cjs')
const { DEFAULT_CONTEXT_TOKENS } = require('./context-builder.cjs')

/** 窗口里留给「输入」的比例 —— 与 compact.ts 的 `MODEL_WINDOW_SHARE` 对齐（0.2 留给输出） */
const MODEL_WINDOW_SHARE = 0.8

/** 这个模型的上下文窗口（token）。查不到 = 0（**未知，不是 0**）。 */
function windowOf(model, provider) {
  const caps = providerCaps.resolve(model, provider?.modelCapabilities).caps
  const w = caps.context_window
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.floor(w) : 0
}

/**
 * 本轮该用多大的上下文基准（token）。
 * @param {{ config?: object, provider?: object, model?: string }} input
 */
function effectiveBaseTokens({ config, provider, model } = {}) {
  /* 0 / 没填 = 跟随窗口；填了 = 用户上限（刹车，不能因为窗口更大就绕过它） */
  const userCap = Number(config?.context?.baseTokens) || 0
  const window = windowOf(model, provider)
  const fromWindow = window > 0 ? Math.floor(window * MODEL_WINDOW_SHARE) : 0
  if (fromWindow && userCap) return Math.min(fromWindow, userCap)
  return fromWindow || userCap || DEFAULT_CONTEXT_TOKENS
}

module.exports = { effectiveBaseTokens, windowOf, MODEL_WINDOW_SHARE }
