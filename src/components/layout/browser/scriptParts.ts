/*
 * 在 webview 里跑的**共用脚本片段**（从 scripts.ts 拆出来 —— 那边贴到 300 行红线了）。
 *
 * 为什么必须共用同一份：snapshot / click / type 三种脚本都靠「遍历可交互元素」，
 * 各自实现一份的话「第 N 个元素」在两边会对不上 —— 点错元素比点不中还糟。
 *
 * 转义提醒：TS 模板字符串里的 `\\s` 到最终脚本里才是 `\s`（正则）。
 */

/** 可交互元素的选择器（snapshot / click / type 共用） */
export const INTERACTIVE_SEL =
  'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[contenteditable="true"],[onclick]'

/**
 * 遍历可交互元素的函数体。
 * 过滤规则：去掉重复的、零尺寸的、视口外的、隐藏的。
 * snapshot 和 click 都内联这一份，保证「第 N 个元素」两边是同一个。
 */
export const WALK_FN = `
  function __walkInteractive() {
    var all = document.querySelectorAll('${INTERACTIVE_SEL}')
    var seen = new Set()
    var vw = window.innerWidth || 0
    var vh = window.innerHeight || 0
    var out = []
    for (var k = 0; k < all.length; k++) {
      var el = all[k]
      if (seen.has(el)) continue
      seen.add(el)
      var rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue
      var cs = window.getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      out.push(el)
    }
    return out
  }
`

/**
 * 落点校验用的辅助（钻 shadow DOM）。
 *
 * 为什么需要：`elementFromPoint` 在 shadow root 边界会停在 host 上，光调它会把
 * 「穿透 shadow 的遮挡」误判成没遮挡。命中核对要一路钻进 shadowRoot 最内层。
 * （dsh-browser 的 pressProbe 做的是同一件事。）
 */
export const CLICK_HELP_FN = `
  function __pointAt(doc, x, y) {
    var el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null
    var guard = 0
    while (el && el.shadowRoot && guard < 10) {
      var inner = el.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === el) break
      el = inner
      guard++
    }
    return el
  }
  function __within(node, host) {
    var cur = node
    var guard = 0
    while (cur && guard < 100) {
      guard++
      if (cur === host) return true
      if (cur.parentNode) { cur = cur.parentNode; continue }
      var root = cur.getRootNode ? cur.getRootNode() : null
      cur = root && root.host ? root.host : null
    }
    return false
  }
`

/**
 * 记「这次 browse_elements 读到的是哪些元素对象」用的键。
 *
 * 为什么挂在 window：snapshot / click / type 是**三次独立的 executeJavaScript 调用**，
 * 只有挂在页面 window 上才能跨调用保留。页面一导航 window 就换了，那份记录自然消失
 * —— 于是「跨页拿旧索引去点」会被下面那道核对拦下。
 */
export const SNAP_KEY = '__harborSnapEls'

/** snapshot 脚本里用：把这次遍历到的元素对象整串记在 window 上（供 click/type 核对身份） */
export const SNAP_SAVE = `try { window.${SNAP_KEY} = list } catch (e) {}`

/**
 * click / type 脚本里用：核对「第 index 个元素」还是不是 browse_elements 时那个。
 *
 * 学 dsh-browser 的「ref 属于页面、不属于快照」：页面变了（元素对象被换掉，
 * 或者整个文档换了），旧索引就可能指到**别的**元素上，而合成点击会静默点到
 * 它、工具还回报「已点击」—— 那是最坏的一种「报告很有说服力但是错的」。
 *
 * 判据是**对象身份**（`===`）：同一元素即使文字变了也还是同一个对象，不会误报；
 * 元素被替换 / 换页 → 拒绝，让模型重新 browse_elements。
 */
export function snapCheckSnippet(index: number): string {
  return `
    var __snapEls = window.${SNAP_KEY}
    if (!__snapEls) {
      return { ok: false, error: '还没读过这个页面的元素（或者页面刚变过）—— 先 browse_elements 看当前页面，再操作' }
    }
    if (__snapEls[${index}] !== target) {
      return { ok: false, error: '页面变了：第 ${index} 个元素已经不是 browse_elements 时看到的那个了（点下去可能落到别的元素上）—— 重新 browse_elements 看当前页面' }
    }
  `
}
