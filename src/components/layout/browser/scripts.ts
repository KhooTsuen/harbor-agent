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
 * 按索引点击（index 是 SNAPSHOT_SCRIPT 返回的 i）
 */
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

/**
 * 按索引往输入框打字（index 来自 SNAPSHOT_SCRIPT）。
 *
 * ⚠️ 不能直接写 `el.value = text` —— React/Vue 的**受控组件**会忽略
 * 直接赋值（它们的内部 state 没变，下一次渲染还会把值盖回去）。
 * 必须用原型上的 native setter 赋值，再 dispatch `input` 事件，
 * 框架才会收到「用户改了值」的信号。这是自动化填表最容易踩的坑。
 *
 * text 用 JSON.stringify 嵌进去：用户输入里可能有引号/换行/反引号，
 * 直接拼进脚本字符串会把脚本写坏。
 */
export function typeScript(
  index: number,
  text: string,
  pressEnter: boolean,
  authorized = false,
): string {
  const enterBlock = pressEnter
    ? `
        /* 回车：keydown/keypress/keyup 都发一遍 —— 不同站点监听的事件不一样 */
        var KE = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }
        target.dispatchEvent(new KeyboardEvent('keydown', KE))
        target.dispatchEvent(new KeyboardEvent('keypress', KE))
        target.dispatchEvent(new KeyboardEvent('keyup', KE))
    `
    : ''

  return `
    (function () {
      try {
        ${WALK_FN}
        var target = __walkInteractive()[${index}]
        if (!target) return { ok: false, error: '索引 ${index} 不存在（页面元素可能变了，重新 browse_elements 看当前页面）' }
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

        var value = ${JSON.stringify(text)}

        target.focus()
        if (tag === 'input' || tag === 'textarea') {
          var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
          setter.call(target, value)
          target.dispatchEvent(new Event('input', { bubbles: true }))
          target.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          target.textContent = value
          target.dispatchEvent(new Event('input', { bubbles: true }))
        }
        ${enterBlock}
        /* 密码不回显 —— 返回值会进模型上下文和对话记录 */
        var echoed = isPassword ? '••••••（已隐藏）' : value.slice(0, 60)
        return { ok: true, typed: echoed, into: tag, password: isPassword }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })()
  `
}
