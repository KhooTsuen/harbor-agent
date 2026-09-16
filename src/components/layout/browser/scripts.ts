/*
 * 在 webview 里跑的脚本（executeJavaScript 执行的字符串）
 *
 * 为什么单独一个文件：这些脚本是「眼睛 + 手」的核心，snapshot 和 click
 * 必须用**完全一样的遍历逻辑**，否则索引对不上 —— 点错元素比点不中还糟。
 * 抽到一起 + 共用 __walkInteractive，保证这一点。
 *
 * 转义提醒：TS 模板字符串里的 `\\s` 到最终脚本里才是 `\s`（正则）。
 */

/** 可交互元素的选择器（snapshot 和 click 共用） */
const INTERACTIVE_SEL =
  'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[contenteditable="true"],[onclick]'

/**
 * 遍历可交互元素的函数体。
 * 过滤规则：去掉重复的、零尺寸的、视口外的、隐藏的。
 * snapshot 和 click 都内联这一份，保证「第 N 个元素」两边是同一个。
 */
const WALK_FN = `
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
 * 读正文的脚本。优先 innerText（渲染后的可见文本），HTML 只兜底。
 */
export const READ_SCRIPT = `
  (function () {
    try {
      var body = document.body ? document.body.innerText : ''
      return {
        text: body || '',
        html: document.documentElement ? document.documentElement.outerHTML : '',
        title: document.title || '',
        url: location.href || ''
      }
    } catch (e) {
      return { text: '', html: '', title: '', url: '', error: String(e) }
    }
  })()
`

/**
 * 可交互元素清单。每个元素：索引、标签、类型、角色、文本、中心坐标 + 尺寸。
 * 坐标从 getBoundingClientRect 拿，是精确的（不像视觉推理会漂）。
 */
export const SNAPSHOT_SCRIPT = `
  (function () {
    try {
      ${WALK_FN}
      var MAX = 80
      var items = []
      var list = __walkInteractive()
      for (var k = 0; k < list.length && items.length < MAX; k++) {
        var el = list[k]
        var rect = el.getBoundingClientRect()
        var text = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '')
          .toString().trim().replace(/\\s+/g, ' ')
        if (text.length > 100) text = text.slice(0, 100)
        items.push({
          i: items.length,
          tag: el.tagName.toLowerCase(),
          type: el.tagName === 'INPUT' ? (el.type || '') : '',
          role: el.getAttribute('role') || '',
          text: text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        })
      }
      return { url: location.href, title: document.title, viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 }, items: items, total: document.querySelectorAll('${INTERACTIVE_SEL}').length }
    } catch (e) {
      return { url: location.href, error: String(e), items: [] }
    }
  })()
`

/** 按索引点击（index 是 SNAPSHOT_SCRIPT 返回的 i） */
export function clickScript(index: number): string {
  return `
    (function () {
      try {
        ${WALK_FN}
        var target = __walkInteractive()[${index}]
        if (!target) return { ok: false, error: '索引 ${index} 不存在（页面元素可能变了，重新 browse_elements 看当前页面）' }
        var tag = target.tagName.toLowerCase()
        var text = (target.innerText || target.value || '').toString().trim().slice(0, 60)
        target.click()
        return { ok: true, clicked: tag + (text ? ' "' + text + '"' : '') }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })()
  `
}
