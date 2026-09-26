/* ══════════════════════════════════════════════════════════════
   锚点：量「视野顶那条内容被推下去多少」

   FREE 的补偿量就是这个位移量（末尾长高 → 0，视野上方长高 → 等于长高量）。
   锚点本身是**浏览器命中测试**的结果（`elementFromPoint`，取内容列水平中心），
   环境不支持时退化成按 children 二分下钻（children 在文档序上单调）。

   为什么不用 `newScrollHeight - oldScrollHeight`：那个差值把「末尾长高」也
   算进去了，照它补就变成每来一段流式内容把用户往下推一段。
   ══════════════════════════════════════════════════════════════ */

/** 锚点下钻的最大层数（防病态结构里空转） */
const ANCHOR_MAX_DEPTH = 12
/** 命中测试点离容器顶的距离（太贴边会落在边框/内边距上） */
const HIT_OFFSET_Y = 6
/** 往上找备胎的最大层数 / 备胎总数上限（都带一次几何读取，别贪） */
const MAX_BACKSTOP_DEPTH = 8
const MAX_BACKSTOPS = 8

/** 一条参照物：某个元素 + 它当时在滚动坐标里的位置 */
export interface AnchorEntry {
  node: Element
  offset: number
}

export interface ScrollAnchor {
  /** 视野顶那个元素（最准，优先用它） */
  primary: AnchorEntry
  /**
   * 备胎（按文档序从近到远）：primary 被这一刀删掉时改用它算位移。
   *
   * 为什么必须是一列而不是一个：折叠一个**跨在视野顶端**的块时，primary 和它的
   * nextSibling 都在被删的子树里 —— 只留一个备胎就等于放弃补偿（真机欠补 975px）。
   * 往上取祖先的兄弟就没事：被折叠子树后面那段内容活得好好的，它的位移正好等于
   * 「上面少了多少」。最后一定兜到 content 自己（永不消失，位移 0）。
   */
  backstops: AnchorEntry[]
}

/** 元素在滚动坐标里的位置（改 scrollTop 不影响它，布局变了才会变） */
export function docOffset(sc: HTMLElement, el: Element): number {
  return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
}

/** 视野顶那个元素（尽量深，尽量贴住那段文字） */
export function pickAnchor(sc: HTMLElement, content: HTMLElement): Element | null {
  const box = content.getBoundingClientRect()
  try {
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      sc.getBoundingClientRect().top + HIT_OFFSET_Y,
    )
    if (hit && hit !== sc && content.contains(hit)) return hit
  } catch {
    /* 环境不支持 elementFromPoint（如 jsdom）→ 走下面的树走 */
  }
  const line = sc.getBoundingClientRect().top + 1
  let node: Element = content
  for (let depth = 0; depth < ANCHOR_MAX_DEPTH; depth += 1) {
    const kids = node.children
    if (kids.length === 0) break
    let lo = 0
    let hi = kids.length - 1
    let found: Element | null = null
    while (lo <= hi) {
      /* 二分：children 按文档序单调，第一个 bottom 越过视野顶的就是它 */
      const mid = (lo + hi) >> 1
      if (kids[mid].getBoundingClientRect().bottom > line) {
        found = kids[mid]
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    if (!found) break
    node = found
  }
  return node
}

/** 就地记下当前锚点 + 一列备胎（都带此刻的滚动坐标位置） */
export function readAnchor(sc: HTMLElement, content: HTMLElement): ScrollAnchor | null {
  const node = pickAnchor(sc, content)
  if (!node) return null
  const seen = new Set<Element>([node])
  const backstops: AnchorEntry[] = []
  const push = (el: Element | null): void => {
    if (!el || seen.has(el) || backstops.length >= MAX_BACKSTOPS) return
    seen.add(el)
    backstops.push({ node: el, offset: docOffset(sc, el) })
  }
  /* 从 primary 往上爬，每层把它后面的兄弟收进来（被删子树后面那段就是它）。
     同时收「前面的兄弟」：插入点在 primary 之上时，它才是量得准的那个。 */
  let cur: Element | null = node
  for (let up = 0; up < MAX_BACKSTOP_DEPTH && cur && cur !== content; up += 1) {
    push(cur.nextElementSibling)
    if (up > 0) push(cur.previousElementSibling)
    cur = cur.parentElement
  }
  push(content)
  return { primary: { node, offset: docOffset(sc, node) }, backstops }
}

/**
 * 这一刀让锚点动了多少（≈ 视野上方多出/少了多少）。
 *
 * primary 还在就用它（最准）；它连同近处兄弟一起被删了，就退到备胎里第一个活着的 ——
 * 那个位移同样等于「上面少了多少」，照样能把视野钉住；全没了就返回 null（这轮不猜）。
 */
export function anchorShift(sc: HTMLElement, anchor: ScrollAnchor | null): number | null {
  if (!anchor) return null
  const pick = anchor.primary.node.isConnected ? anchor.primary : findAlive(anchor.backstops)
  if (!pick) return null
  return docOffset(sc, pick.node) - pick.offset
}

function findAlive(entries: readonly AnchorEntry[]): AnchorEntry | null {
  return entries.find((e) => e.node.isConnected) ?? null
}
