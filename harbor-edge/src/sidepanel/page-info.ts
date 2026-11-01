/**
 * M02-B：**当前网页卡的纯逻辑**（不碰 React、不碰 chrome）
 *
 * ── 为什么从 `PageCard.tsx` 抽出来 ─────────────────────────────
 *
 * `canRead()` 是「这个页面能不能读」的**唯一判据** —— 产品 manifest 刻意没有
 * `tabs` 权限（M07 最小权限），所以 url 只有在 `activeTab` 授予后才看得见。
 * 这条判据如果只活在 `.tsx` 里，自检就**测不到它**（Node 不认 JSX），
 * 而它恰恰是最该被钉住的一条：判错了，卡片会对读不了的页面显示「能读」，
 * 用户点下去才发现失败。
 *
 * 抽成纯函数后：`PageCard.tsx` 只负责画，本文件被 `176-m02b-cards.mjs` 直接跑。
 */

/** 上下文开关的存储键（`chrome.storage.local`，**不进 Harbor**） */
export const CTX_KEY = 'harborContextEnabled'

export interface PageInfo {
  title: string
  /** 空串 = 拿不到（`activeTab` 未授予，或不是普通网页） */
  url: string
}

/**
 * 这个页面能不能读。
 *
 * ★ **唯一判据**：拿得到 url 才读得了 —— 与 `lib/active-tab.js`、M03 同一口径。
 *   不另立一套（比如「猜 manifest 有没有权限」），那种判法会与真实行为漂开。
 */
export function canRead(info: PageInfo | null): boolean {
  return Boolean(info && String(info.url ?? '').trim())
}

/** 显示用的域名（拿不到 url 时给一句人话，不显示空白让人猜） */
export function hostLabel(info: PageInfo | null): string {
  if (!canRead(info)) return '读不到地址'
  try {
    return new URL(String(info!.url)).host || String(info!.url)
  } catch {
    return String(info!.url)
  }
}

/** 标题为空时退回域名（很多页面 title 是空的） */
export function titleLabel(info: PageInfo | null): string {
  if (!info) return '没有活动页面'
  const t = String(info.title ?? '').trim()
  return t || hostLabel(info)
}

/**
 * 上下文开关该不该视为「开」。
 *
 * ★ 默认 **开**：装好就想「读当前页」直接可用；关掉是**主动动作**，所以只有
 *   明确存了 `false` 才算关。读不出来（storage 坏了）也按开 —— 与默认策略同向，
 *   而且真读不了页面时后面那一步会自己报人话。
 */
export function ctxEnabledFrom(stored: unknown): boolean {
  return (stored as { [k: string]: unknown })?.[CTX_KEY] !== false
}
