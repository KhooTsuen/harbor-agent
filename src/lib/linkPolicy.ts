/*
 * 「这个地址能不能画成可点的链接」—— 渲染层的判据，只有这一份（审计问题 18）。
 *
 * ⚠️ 它**不是**安全边界。真正开不开由**主进程**那道白名单说了算
 * （`electron/core/url-policy.cjs`，只放行 http / https / mailto）。
 * 渲染层这一步只决定「画不画成链接」—— 漏了顶多是多一段误导人的可点文字，
 * 不会真的打开什么。两道**都**拦，任一边漏都还有另一边兜着。
 *
 * 跨进程没法共享同一个模块（一个 .cjs 一个 .ts），所以判据天然是两份；
 * 所以这里更要把「为什么两份」写清楚，免得后来人以为改一处就够。
 *
 * 2026-10-04 去掉 `file:` —— 它以前被放行，于是
 * `[点我](file:///C:/Windows/system.ini)` 会渲染成可点链接：这是个本地 Agent，
 * 本地路径到处都是，一条聊天消息就能把「任意本地文件」变成一次点击。
 */
const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i

/** 空、非字符串、不在白名单里 —— 一律「不当链接画」 */
export function isSafeHref(raw: string | null | undefined): boolean {
  const href = String(raw ?? '').trim()
  return href.length > 0 && SAFE_HREF.test(href)
}
