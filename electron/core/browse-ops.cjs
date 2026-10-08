/**
 * 页面操作脚本（snapshot / 落点 / 聚焦），在主进程经 CDP 执行
 *
 * 端口自渲染层的 `src/components/layout/browser/scripts.ts` + `scriptParts.ts`（B3，2026-10-09）：
 * 这些脚本原来是**渲染层** `executeJavaScript` 跑的，现在改由主进程经 `core/cdp.cjs`
 * 的 `Runtime.evaluate` 执行。渲染层只负责「确保 webview 就绪 + 回报 webContentsId」。
 *
 * ★ 为什么三种脚本要共用同一份遍历逻辑：snapshot 返回的索引、click/type 拿它定位，
 *   必须用**完全一样**的 `__walkInteractive()`，否则「第 N 个元素」两边对不上 ——
 *   点错元素比点不中还糟。所以 `WALK_FN` 只在这里写一份。
 *
 * ★ `window.__harborSnapEls`（SNAP_KEY）：snapshot 时把这次遍历到的**元素对象**记在
 *   页面 window 上，click/type 派发前用**对象身份**核对「还是不是那个元素」。页面一导航
 *   window 就换了，记录自然消失 —— 于是「跨页拿旧索引去点」会被拦下。三次调用都在同一
 *   页面上下文里跑（CDP evaluate 与 executeJavaScript 都作用于页面主世界），所以这条链照旧成立。
 *
 * ⚠️ 顶层**不 require electron**（cdp 延迟到 run* 里拿）—— 这样 vitest 能直接 import
 *    本模块验脚本（jsdom 里 eval 真跑一遍），而不必开 Electron。
 *
 * 转义提醒：模板字符串里的 `\\s` 到最终脚本里才是 `\s`（正则）。
 */

/** 可交互元素的选择器（snapshot / click / type 共用） */
const INTERACTIVE_SEL =
  'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[contenteditable="true"],[onclick]'

/**
 * 遍历可交互元素的函数体。过滤：去重、零尺寸、视口外、隐藏。
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
 * 落点校验的辅助（钻 shadow DOM）。
 * `elementFromPoint` 在 shadow root 边界会停在 host 上，光调它会把「穿透 shadow 的遮挡」
 * 误判成没遮挡 —— 命中核对要一路钻进 shadowRoot 最内层。
 */
const CLICK_HELP_FN = `
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

/** 记「这次 snapshot 读到的是哪些元素对象」用的键 */
const SNAP_KEY = '__harborSnapEls'

/** snapshot 脚本里用：把这次遍历到的元素对象整串记在 window 上（供 click/type 核对身份） */
const SNAP_SAVE = `try { window.${SNAP_KEY} = list } catch (e) {}`

/**
 * click / type 脚本里用：核对「第 index 个元素」还是不是 snapshot 时那个。
 * 判据是**对象身份**（`===`）：同一元素即使文字变了也还是同一个对象，不会误报。
 */
function snapCheckSnippet(index) {
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

/** 可交互元素清单（索引 / 标签 / 类型 / 角色 / 文本 / 中心坐标 + 尺寸） */
const SNAPSHOT_SCRIPT = `
  (function () {
    try {
      ${WALK_FN}
      var MAX = 80
      var items = []
      var list = __walkInteractive()
      ${SNAP_SAVE}
      for (var k = 0; k < list.length && items.length < MAX; k++) {
        var el = list[k]
        var rect = el.getBoundingClientRect()
        /*
         * 密码框不读值 —— 读出来会把密码原样带进模型上下文、工具结果和会话。
         * 只告诉「填没填」，不告诉填了什么。
         */
        var isPassword = el.tagName === 'INPUT' && el.type === 'password'
        var text = ''
        if (isPassword) {
          text = el.value
            ? '••••••（已填）'
            : (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '密码框')
        } else {
          text = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '')
        }
        text = text.toString().trim().replace(/\\s+/g, ' ')
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

/**
 * 把「元素索引」规整成非负整数。
 * ⚠️ 千万别写 `Number(x) || -1` —— **索引 0 会变成 -1**（0 是 falsy）。
 */
function toIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : -1
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return -1
}

/**
 * 按索引算**点击落点**（index 是 SNAPSHOT_SCRIPT 返回的 i）。只算点、不点 ——
 * 真点击由主进程 `sendInputEvent` 派发（见 `core/real-input.cjs`）。
 */
function clickPointScript(index, force = false) {
  return `
    (function () {
      try {
        ${WALK_FN}
        ${CLICK_HELP_FN}
        var target = __walkInteractive()[${index}]
        if (!target) return { ok: false, error: '索引 ${index} 不存在（页面元素可能变了，重新 browse_elements 看当前页面）' }
        ${snapCheckSnippet(index)}
        var tag = target.tagName.toLowerCase()
        var text = (target.innerText || target.value || '').toString().trim().slice(0, 60)
        var label = tag + (text ? ' "' + text + '"' : '')
        var rect = target.getBoundingClientRect()
        var cx = rect.left + rect.width / 2
        var cy = rect.top + rect.height / 2
        var vw = window.innerWidth || 0
        var vh = window.innerHeight || 0
        if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
          return { ok: false, error: '<' + label + '> 的中心点 (' + Math.round(cx) + ',' + Math.round(cy) + ') 在视口外，点不到 —— 先滚动页面或重新 browse_elements' }
        }
        var hit = __pointAt(document, cx, cy)
        var onTarget = hit === target || __within(hit, target)
        if (!onTarget && !(${force === true})) {
          var hitTag = hit && hit.tagName ? hit.tagName.toLowerCase() : '别的元素（或什么都没有）'
          return { ok: false, error: '<' + label + '> 的落点被 <' + hitTag + '> 挡住了，点下去到不了它。确认要强点就带 force:true；否则先关掉遮挡层再点' }
        }
        return { ok: true, x: Math.round(cx), y: Math.round(cy), label: label, obstructed: !onTarget }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })()
  `
}

/**
 * 按索引**聚焦 + 校验**输入框。只聚焦、不写字 —— 真文字由主进程 `insertText` 插入。
 * 写之前先问页面「这个控件收不收文本」（readonly/disabled/焦点没落上 → 一个字符都不打）。
 */
function focusScript(index, authorized = false) {
  return `
    (function () {
      try {
        ${WALK_FN}
        var target = __walkInteractive()[${index}]
        if (!target) return { ok: false, error: '索引 ${index} 不存在（页面元素可能变了，重新 browse_elements 看当前页面）' }
        ${snapCheckSnippet(index)}
        var tag = target.tagName.toLowerCase()
        var isField = tag === 'input' || tag === 'textarea' || target.isContentEditable
        if (!isField) return { ok: false, error: '第 ${index} 个元素是 <' + tag + '>，不是输入框，打不了字' }

        /*
         * 密码框：没拿到用户明确授权就不动，回去让宿主弹确认。
         * 光靠提示词约束不够 —— 这里也卡一道（和「危险命令」一个道理）。
         */
        var isPassword = tag === 'input' && target.type === 'password'
        var authorized = ${authorized === true}
        if (isPassword && !authorized) {
          return { ok: false, needsConfirm: true, label: '密码框' }
        }

        if (target.disabled === true) {
          return { ok: false, error: '第 ${index} 个元素被禁用了（disabled），它收不了输入 —— 什么都没打。先 browse_elements 看看当前页面状态' }
        }
        if (target.readOnly === true) {
          return { ok: false, error: '第 ${index} 个元素是只读的（readonly），它收不了输入 —— 什么都没打。先 browse_elements 看看当前页面状态' }
        }

        target.focus()
        var __active = document.activeElement
        if (__active !== target && !(target.contains && __active && target.contains(__active))) {
          return { ok: false, error: '焦点没落到第 ${index} 个元素上（页面没让它聚焦），文字会跑到别处 —— 什么都没打。先 browse_elements 看看当前页面状态' }
        }
        return { ok: true, into: tag, password: isPassword }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })()
  `
}

/* ── CDP 执行（延迟 require，顶层不碰 electron） ── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在页面里跑一段脚本并取值，**失败会重试**。
 *
 * 原来渲染层 `executeJavaScript` 有个「guest 没就绪就重试」的补丁
 * （真机见过 `GUEST_VIEW_MANAGER_CALL: Script failed to execute`）。
 * 操作改到主进程后，这个职责挪到这儿。渲染层回 `ready` 前已等过 dom-ready，
 * 但重试仍是廉价的保险（CDP attach 的时序、刚导航完的窗口期）。
 */
async function evaluateWithRetry(webContentsId, script, tries = 3) {
  const cdp = require('./cdp.cjs')
  let last
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await cdp.evaluate(webContentsId, script)
    } catch (error) {
      last = error
      if (attempt < tries) await sleep(250)
    }
  }
  throw last
}

async function runSnapshot(webContentsId) {
  return evaluateWithRetry(webContentsId, SNAPSHOT_SCRIPT)
}

async function runClickPoint(webContentsId, index, force) {
  return evaluateWithRetry(webContentsId, clickPointScript(index, force === true))
}

async function runFocus(webContentsId, index, authorized) {
  return evaluateWithRetry(webContentsId, focusScript(index, authorized === true))
}

module.exports = {
  INTERACTIVE_SEL,
  WALK_FN,
  CLICK_HELP_FN,
  SNAP_KEY,
  SNAP_SAVE,
  snapCheckSnippet,
  SNAPSHOT_SCRIPT,
  clickPointScript,
  focusScript,
  toIndex,
  runSnapshot,
  runClickPoint,
  runFocus,
}
