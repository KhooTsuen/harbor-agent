/*
 * 在 webview 里跑的脚本（executeJavaScript 执行的字符串）
 *
 * 为什么单独一个文件：这些脚本是「眼睛 + 手」的核心，snapshot 和 click
 * 必须用**完全一样的遍历逻辑**，否则索引对不上 —— 点错元素比点不中还糟。
 * 三种脚本共用的片段抽在 `scriptParts.ts`（那边不容易撞 300 行红线）。
 *
 * 转义提醒：TS 模板字符串里的 `\\s` 到最终脚本里才是 `\s`（正则）。
 */

import { INTERACTIVE_SEL, WALK_FN, CLICK_HELP_FN, SNAP_SAVE, snapCheckSnippet } from './scriptParts'

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
 *
 * 顺带把这次遍历到的元素对象记到 window 上（SNAP_SAVE）—— 后面的 click/type
 * 靠它核对「还是不是这些元素」，见 scriptParts.ts 的 snapCheckSnippet。
 */
export const SNAPSHOT_SCRIPT = `
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
 *
 * ⚠️ 千万别写 `Number(x) || -1` —— **索引 0 会变成 -1**（0 是 falsy），
 * 「点/输入第一个元素」直接失效。真机抓到的坑（browse_click(0)/browse_type(0) 全挂）。
 */
export function toIndex(value: unknown): number {
  /* 只认「数字」和「纯数字字符串」两种写法 —— 不能用 Number() 一把梭：
     Number(null)/Number('')/Number(false) 都是 0，会把「没传索引」当成索引 0。 */
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : -1
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return -1
}

/**
 * 按索引算**点击落点**（index 是 SNAPSHOT_SCRIPT 返回的 i）。
 *
 * 只算点、不点 —— 真点击由**主进程** `sendInputEvent` 派发（isTrusted: true）。
 * 渲染层在沙箱里派发的 `target.click()` 是合成事件（isTrusted: false），
 * 查可信度的站点会忽略它。所以这里只做校验 + 回坐标，见 `core/real-input.cjs`。
 *
 * 两道核对（学 dsh-browser）：
 *   ① 身份（snapCheckSnippet）：还是不是 browse_elements 时那个元素？跨页/重渲染就拒绝。
 *   ② 落点：被别的元素挡住就**默认拒绝**（click-point-and-interception）。force=true 才放行，
 *      并把 `obstructed` 写进回报。落点在视口外一律拒绝，force 也不放行。
 */
export function clickPointScript(index: number, force = false): string {
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
 * 按索引**聚焦 + 校验**输入框（index 来自 SNAPSHOT_SCRIPT）。
 *
 * 只聚焦、不写字 —— 真文字由**主进程** `webContents.insertText()` 插入（真实
 * beforeinput/input 事件，isTrusted: true），回车由主进程 `sendInputEvent` 派发。
 * 见 `core/real-input.cjs`。
 *
 * 派发前先问页面「这个控件收不收文本」（学 dsh-browser 的 typing-actionability）：
 * 不问的话回报会是假的 —— 往 readonly/disabled 框里塞值，工具回「已输入」而框里
 * 一直是空的，模型以为填好了、接着去提交一个空表单。所以这里**一个字符都不打**。
 *
 * 顺序：先判元素自己的状态（disabled/readonly），再看焦点落没落上。反过来先判焦点
 * 的话，禁用的框会因为「聚焦失败」被报成「焦点没落上」，真正的原因（disabled）
 * 永远传不出来 —— 这正是 dsh 真机上踩过的坑。
 */
export function focusScript(index: number, authorized = false): string {
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
