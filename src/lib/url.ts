/**
 * 两个地址是不是「同一个页面」。
 *
 * 为什么需要这个函数：Agent 调 `browse` 时给的地址是人手写的，写法不统一 ——
 *
 *   https://example.com
 *   https://example.com/
 *   HTTPS://Example.com
 *
 * 都是同一个页面。用严格字符串比较会把它当成新地址，造成两件坏事：
 *
 *   · store 里会开出**第二个标签**（用户看着莫名其妙）
 *   · driver 里会白白 `loadURL` 一次 —— 页面重新加载，
 *     刚填了一半的表单、滚动位置、SPA 状态全没了
 *
 * 所以两处都用这个函数比。域名大小写不敏感、末尾斜杠可省；
 * **路径、查询、锚点一律保持原样**（它们本来就区分页面）。
 */
export function sameUrl(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

function normalizeForCompare(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''

  try {
    const url = new URL(text)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`
  } catch {
    /* 不是完整 URL（about:blank 这种），退化成朴素比较 */
    return text.replace(/\/+$/, '')
  }
}
