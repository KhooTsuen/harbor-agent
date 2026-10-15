/**
 * M03 网页观察采集器（注入进页面执行）
 *
 * ── ★★ 最重要的一条规矩：`collectPageContext` **必须自包含** ★★
 *
 * 它经 `chrome.scripting.executeScript({ func })` 注入页面 —— Chrome 把函数
 * `toString()` **序列化**后送进页面，所以函数体内**只能引用自己的参数、局部
 * 变量、和嵌套定义的函数**。引用任何模块级常量 / 导入 → 注入后 `ReferenceError`。
 *
 * 而这**单测抓不到**（Node 里 require 时一切都在），**只有真机会现形**。
 * 所以常量写在函数体内、辅助函数嵌套在函数体内。真机判据 ⑥ 专门钉这条。
 *
 * 形状与算法见 `docs/research/edge-extension-m03-design.md`（唯一真相源）。
 */

/**
 * 采集当前页面的结构化观察结果。
 *
 * ⚠️ 参数走**可选对象**：`executeScript` 的 `func` 只能传 JSON 可序列化的 `args`。
 *
 * @param {{ maxItems?: number, maxSelection?: number }} [opts]
 */
export function collectPageContext(opts) {
  const maxItems = Number(opts && opts.maxItems) > 0 ? Number(opts.maxItems) : 60
  const maxSelection = Number(opts && opts.maxSelection) > 0 ? Number(opts.maxSelection) : 4000
  /** 单个字段上限（文档 §6：先给结构与引用，细读按需） */
  const TEXT_CAP = 80
  /** 敏感字段：命中即**不返回任何字符**（连长度都不给 —— 长度也是信息，M07） */
  const SENSITIVE = /(password|passwd|pwd|passcode|card|cc-number|cc-csc|cvv|ssn|secret|token|otp|verification|验证码|密码|身份证|银行卡)/i
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    '[onclick]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="combobox"]',
  ].join(',')

  /** 压掉空白 + 截断（用于标签这类「一行文本」） */
  const cut = (s, n) => {
    const t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n)}…` : t
  }
  /** 只截断、**不压空白**（选区可能多行，压了就失真） */
  const clip = (s, n) => {
    const t = String(s === null || s === undefined ? '' : s)
    return t.length > n ? t.slice(0, n) : t
  }

  /**
   * FNV-1a（32 位）—— 为什么不用 `crypto.subtle`：那是**异步**的，
   * 而指纹要参与「同步生成 ref」。这里 CPU 可忽略，且同一输入永远同一结果。
   */
  function fnv1a(str) {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /** 可见性：优先用 `checkVisibility`（现代 Chromium），退化到几何 + 计算样式 */
  function visible(el) {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      }
    } catch {
      /* 老版本没有这个 API，走下面 */
    }
    try {
      const r = el.getBoundingClientRect()
      if (r.width <= 1 || r.height <= 1) return false
      const st = window.getComputedStyle(el)
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0'
    } catch {
      return false
    }
  }

  /** 角色：显式 `role` 优先；否则从标签 + 类型推断（与文档 §4.5 的语义对齐） */
  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return cut(explicit, 30)
    const tag = String(el.tagName || '').toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = String(el.type || 'text').toLowerCase()
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return tag || 'generic'
  }

  /** 这个控件是不是敏感字段（决定「能不能把 value 带出去」） */
  function isSensitive(el) {
    if (String(el.tagName || '').toUpperCase() === 'INPUT' && String(el.type || '').toLowerCase() === 'password') {
      return true
    }
    const hay = [el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
      .filter(Boolean)
      .join(' ')
    return SENSITIVE.test(hay)
  }

  /** 人读的那行标签：aria-label → title → placeholder → alt → value → 文本 → name */
  function labelOf(el, masked) {
    const cand =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      (masked ? '' : el.value) ||
      el.innerText ||
      el.textContent ||
      el.getAttribute('name') ||
      ''
    return cut(cand, TEXT_CAP)
  }

  /* ── ① 扫描可交互元素（不可见的不上列表，但要能解释「为什么没列」）── */
  let candidates = []
  try {
    candidates = Array.from(document.querySelectorAll(SELECTOR))
  } catch {
    candidates = []
  }
  const seen = new Set()
  const picked = []
  let visibleTotal = 0
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i]
    if (!el || seen.has(el)) continue
    seen.add(el)
    if (!visible(el)) continue
    visibleTotal += 1
    if (picked.length < maxItems) picked.push(el)
    /* 已经知道「还有更多」就够了 —— 不必把整页可见元素都数完 */
    else if (visibleTotal > maxItems) break
  }
  const truncated = visibleTotal > picked.length

  /* ── ② 指纹 → 页面版本号（结构或文案变一个字符就变）── */
  const maskedFlags = picked.map((el) => isSensitive(el))
  const signature = picked
    .map((el, i) => [roleOf(el), el.tagName, labelOf(el, maskedFlags[i]), el.disabled ? 'd' : '', el.checked === true ? 'c' : ''].join('|'))
    .join('\u0002')
  let bodyLen = 0
  try {
    bodyLen = document.body ? String(document.body.innerText || '').length : 0
  } catch {
    bodyLen = 0
  }
  const version = fnv1a(
    `${location.href}\u0001${document.title || ''}\u0001${signature}\u0001${bodyLen}`,
  )

  /* ── ③ 分配 ref 并**登记**（M04 要用它拿回元素；WeakRef 不阻止回收）── */
  const refs = new Map()
  const register = (ref, el) => {
    try {
      refs.set(ref, new WeakRef(el))
    } catch {
      /* 老环境没有 WeakRef：退化成强引用（只留最近一次，不会无限涨） */
      refs.set(ref, { deref: () => el })
    }
  }

  const elements = picked.map((el, i) => {
    const ref = `${version}.${i + 1}`
    register(ref, el)
    const masked = maskedFlags[i]
    const tag = String(el.tagName || '')
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    return {
      ref,
      role: roleOf(el),
      tag,
      text: labelOf(el, masked),
      disabled,
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      /* ★ 敏感字段：value 一律 null（不脱敏、不截断，直接不给） */
      value: masked ? null : cut(el.value, TEXT_CAP) || null,
      masked,
      placeholder: cut(el.getAttribute('placeholder') || '', TEXT_CAP),
      href: tag.toUpperCase() === 'A' ? clip(el.getAttribute('href') || '', 200) : '',
      visible: true,
    }
  })

  /* ── ④ 选区（文本 + 所在元素 ref）── */
  let selection = null
  try {
    const s = window.getSelection()
    const raw = s ? String(s.toString()) : ''
    if (raw.trim()) {
      let el = s.anchorNode
      el = el && el.nodeType === 1 ? el : el && el.parentElement
      let ref = ''
      if (el) {
        const idx = picked.indexOf(el)
        if (idx >= 0) ref = `${version}.${idx + 1}`
        else {
          ref = `${version}.s${refs.size + 1}`
          register(ref, el)
        }
      }
      selection = { text: clip(raw, maxSelection), ref, tag: el ? String(el.tagName || '') : '', truncated: raw.length > maxSelection }
    }
  } catch {
    selection = null
  }

  /* ── ⑤ iframe 能力检测：读不到就**如实报原因**，内容字段一律空 ── */
  const frames = []
  try {
    const list = Array.from(document.querySelectorAll('iframe, frame'))
    const cap = Math.min(list.length, 20)
    for (let i = 0; i < cap; i += 1) {
      const f = list[i]
      let accessible = false
      let reason = ''
      try {
        accessible = Boolean(f.contentDocument)
        if (!accessible) reason = '跨域（浏览器不允许读它的内容）'
      } catch {
        reason = '跨域（访问被拒绝）'
      }
      frames.push({ index: i, src: clip(String(f.src || ''), 200), title: cut(f.title || '', TEXT_CAP), accessible, reason })
    }
    if (list.length > cap) frames.push({ index: -1, src: '', title: '', accessible: false, reason: `另有 ${list.length - cap} 个 iframe 未逐个检查（超出 20 个上限）` })
  } catch {
    /* 拿不到 iframe 列表不算致命 */
  }

  /* ── ⑥ open shadow root 计数（closed 的**浏览器不暴露**，不猜数量）── */
  let openShadow = 0
  let scannedForShadow = false
  try {
    const all = document.body ? document.body.querySelectorAll('*') : []
    const cap = Math.min(all.length, 3000)
    for (let i = 0; i < cap; i += 1) if (all[i].shadowRoot) openShadow += 1
    scannedForShadow = all.length <= 3000
  } catch {
    scannedForShadow = false
  }

  /* ── ⑦ 登记命名空间（M04 按 ref 取回元素；只留最近一次观察）── */
  try {
    window.__harborObs = { version, refs, at: Date.now() }
  } catch {
    /* 页面可能冻结 window —— 不影响本次返回值 */
  }

  let lang = ''
  try {
    lang = document.documentElement ? String(document.documentElement.lang || '') : ''
  } catch {
    lang = ''
  }

  return {
    source: 'extension',
    url: String(location.href),
    title: String(document.title || ''),
    lang,
    pageVersion: version,
    at: Date.now(),
    selection,
    elements,
    frames,
    shadow: {
      open: openShadow,
      /* ⚠️ closed shadow root 的 shadowRoot 是 null —— 检测不到，所以**不报数量**，只说明 */
      note: scannedForShadow ? 'closed shadow root 无法枚举（浏览器不暴露）' : '元素过多，open shadow root 计数是下界；closed 的无法枚举',
    },
    stats: { elements: elements.length, maxItems, truncated, textLen: bodyLen },
  }
}
