/* ══════════════════════════════════════════════════════════════
   锚点：量「视野顶那条内容被推下去多少」

   FREE 的补偿量就是这个位移量（末尾长高 → 0，视野上方长高 → 等于长高量）。

   锚点用**按 children 二分下钻**取：从内容容器往下走，每层找「bottom 越过视野顶」
   的那个孩子（children 在文档序上单调），直到叶子或到深度上限。

   为什么不用 `elementFromPoint`：真机 CPU Profile 量过 —— 14 万节点的长会话里，
   它每次要 **~12ms**（命中测试要穿过整棵树），而滚动事件每帧都来一次：
   于是长会话滚动稳定跑到 30fps（P50 33.3ms），这是纯自己造成的开销。
   二分下钻只读 ~深度×log2(孩子数) 个 rect（实测每帧 <0.2ms），而且更贴切：
   它落到**块级**元素上（段落/代码块），而不是行内的某个 span ——
   块级元素在 layout 变化时不容易被换掉，当参照物更稳。

   为什么不用 `newScrollHeight - oldScrollHeight`：那个差值把「末尾长高」也
   算进去了，照它补就变成每来一段流式内容把用户往下推一段。
   ════════════════════════════════════════════════════════════ */

/** 锚点下钻的最大层数（防病态结构里空转） */
const ANCHOR_MAX_DEPTH = 12
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

/* ══════════════════════════════════════════════════════════════
   消息级锚点（切换对话回来时用）

   上面那套锚点只活在一次持续的滚动里：它握着 Element 引用，切对话那一刻
   列表已经卸载（空对话先画开屏），引用断开、rect 也读不到，所以**切走时
   再采已经来不及** —— 必须像 `lastTopRef` 那样，在每次 scroll / 布局变化时
   顺手把「视野顶是哪条消息、它离视口顶多少」记下来。

   为什么不用 scrollTop 当位置：切回来时 MessageList 只渲染最近若干条
   （`tailCount` 从 6 起、最多自动补到 24），用户原来看到的那条**可能还没
   渲染**；同一个像素此时对应的是另一段内容。只有 messageId 才是跨「窗口
   大小变化 / 内容高度变化」都成立的身份。

   `index` 是降级用的：离开期间那条消息被删了，就退到「离开时同下标附近」
   那条仍然存在的消息 —— 附近还是原来那段历史，视图不会跳到别处。
   ══════════════════════════════════════════════════════════════ */

export interface MessageAnchor {
  messageId: string
  /** 消息顶部相对滚动容器视口顶的像素；负数 = 消息顶已滚到视口上方 */
  offset: number
  /** 采集那一刻它在列表里的下标；-1 = 读不到（老 DOM 结构） */
  index: number
}

const MESSAGE_ATTR = 'data-message-id'
const INDEX_ATTR = 'data-message-index'

/** 视野顶那条消息 + 它此刻的位置（常态只走 closest，不扫全表） */
export function readMessageAnchor(sc: HTMLElement, content: HTMLElement): MessageAnchor | null {
  const node = pickAnchor(sc, content)
  const el = node?.closest(`[${MESSAGE_ATTR}]`) ?? firstMessageOver(sc, content)
  const messageId = el?.getAttribute(MESSAGE_ATTR)
  if (!el || !messageId) return null
  const raw = el.getAttribute(INDEX_ATTR)
  const index = raw === null ? -1 : Number(raw)
  return {
    messageId,
    offset: el.getBoundingClientRect().top - sc.getBoundingClientRect().top,
    index: Number.isFinite(index) ? index : -1,
  }
}

/** pickAnchor 落到内容容器自己（视野顶压在按钮 / 空隙上）时，取第一条越过视野顶的消息 */
function firstMessageOver(sc: HTMLElement, content: HTMLElement): Element | null {
  const line = sc.getBoundingClientRect().top
  const kids = content.children
  for (let i = 0; i < kids.length; i += 1) {
    if (kids[i].getBoundingClientRect().bottom <= line) continue
    /* 那个子节点可能不是消息本身（「载入更早」按钮、末尾那条检查点栏）——
       在它内部找消息；找不到就继续往下看，别把一次采锚点丢成 null */
    const hit = kids[i].matches(`[${MESSAGE_ATTR}]`)
      ? kids[i]
      : (kids[i].querySelector(`[${MESSAGE_ATTR}]`) ?? kids[i].closest(`[${MESSAGE_ATTR}]`))
    if (hit) return hit
  }
  return null
}

/**
 * 恢复时找目标消息：只按 id。
 * ★ 这里**不做**「找不到就按下标就近」的降级：扩窗是一点一点补的，目标还没进
 *   窗口时「最近的那条」是窗口末端的邻居 —— 对着它落位会算出恰好对齐的结果，
 *   于是提前宣告成功，等目标真渲染出来用户已经在别处（真机就是这么假成功的）。
 *   目标到底还在不在，由 `MessageList` 用完整的 messages 判（它知道全量顺序），
 *   确实被删了由它显式 `retarget`，落点仍按「离开时的下标」取邻居。
 */
export function findAnchorEl(content: HTMLElement, anchor: MessageAnchor): Element | null {
  return content.querySelector(`[${MESSAGE_ATTR}="${cssEscape(anchor.messageId)}"]`)
}

/** 消息 id 是外部数据（可能带引号 / 冒号），进选择器前先转义 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** 要把目标消息放回离开时那一行，scrollTop 该是多少 */
export function anchorTop(sc: HTMLElement, el: Element, anchor: MessageAnchor): number {
  return docOffset(sc, el) - anchor.offset
}

/** 落位真的对上了吗（±1px）—— 没对上就不许宣告恢复完成 */
export function anchorAligned(sc: HTMLElement, el: Element, anchor: MessageAnchor): boolean {
  const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - anchor.offset
  return Math.abs(delta) <= 1
}

/** 视野顶那个元素（尽量深，尽量贴住那段文字）—— 二分下钻，不碰命中测试 */
export function pickAnchor(sc: HTMLElement, content: HTMLElement): Element | null {
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
