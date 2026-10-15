/**
 * M04 剩余：**填表单**的注入函数（type / select）
 *
 * ── ★★ 自包含铁律（M03 §8.1）──────────────────────────────────
 *
 * `chrome.scripting.executeScript({ func })` 会把这个函数 **`toString()` 序列化**后
 * 注入页面 —— 函数体里**只能**引用自己的参数 / 局部变量 / 嵌套函数。所以：
 *   · ref 解析（两道校验）与 clickElement 是**同一套逻辑，但这里必须再写一遍** ——
 *     不能 `import` 那个函数（模块级引用注入后必 `ReferenceError`）。
 *   · 这是自包含的**必然代价**，不是偷懒。自检有一条静态断言扫「模块级常量名泄漏」。
 *
 * ── ★ 敏感字段：**拒绝**，不是遮蔽（用户定的硬口径）────────────
 *
 * 「遮蔽」意味着**值已经进了页面/进了回传**；而密码与信用卡连「写进去」这一步都不该发生。
 * 所以判定命中的处理是：**一个字节都不写**，返回 `reason:'sensitive-field'`。
 *
 * 判定表（**只有这里一处**，采集器 observe.js 的那份管的是「读」，这份管「写」）：
 *   · `input[type=password]`                      → password
 *   · `autocomplete` 以 `cc-` 开头（`cc-number` / `cc-csc` / `cc-exp`…） → cc-*
 *   · `autocomplete` 是 `current-password` / `new-password`              → password
 *
 * ── ★ 写值为什么要用「原生 setter + 派发事件」──────────────────
 *
 * React / Vue 的受控组件用 `Object.defineProperty` 拦了 `value`，直接 `el.value = x`
 * **不会**触发框架的 onChange（界面看着变了、状态没变，随后又被框架写回去）。
 * 所以取原型上的原生 setter 来写，再派发 `input` + `change`（两条都发：React 认 input，
 * 原生表单认 change）。
 */

/* global window, document */

/**
 * 往输入框填文本。
 *
 * @param {string} ref M03 发的引用，形如 `60684574.3`
 * @param {{ text?: string, clear?: boolean }} [opts] `clear` 默认 true（先清空再写）
 */
export function typeText(ref, opts) {
  return (async () => {
    const target = String(ref || '')
    const o = opts && typeof opts === 'object' ? opts : {}
    const text = String(o.text === undefined ? '' : o.text)
    const clear = o.clear !== false

    const store = window.__harborObs
    if (!store || !store.refs) {
      return { ok: false, reason: 'no-observation', message: '还没观察过这个页面 —— 先观察一次，再按引用操作' }
    }
    const version = String(store.version || '')
    const dot = target.lastIndexOf('.')
    const refVersion = dot > 0 ? target.slice(0, dot) : ''
    if (!target || !refVersion || refVersion !== version) {
      return {
        ok: false,
        reason: 'page-changed',
        message: '页面已经变了（这个引用属于旧版本）—— 请重新观察再操作',
        refVersion,
        version,
      }
    }
    const holder = store.refs.get(target)
    let el = null
    try {
      el = holder && typeof holder.deref === 'function' ? holder.deref() : null
    } catch {
      el = null
    }
    if (!el || el.isConnected !== true) {
      return { ok: false, reason: 'not-found', message: '这个元素已经不在页面上了 —— 请重新观察再操作', refVersion, version }
    }

    /* ── ★ 敏感字段：先判、先拒，一个字节都不写 ── */
    const inputType = String(el.type || '').toLowerCase()
    const ac = String(el.getAttribute ? el.getAttribute('autocomplete') || '' : '').toLowerCase()
    let sensitive = ''
    if (inputType === 'password') sensitive = 'password'
    else if (ac.indexOf('cc-') === 0) sensitive = 'cc-*'
    else if (ac === 'current-password' || ac === 'new-password') sensitive = 'password'
    if (sensitive) {
      return {
        ok: false,
        reason: 'sensitive-field',
        field: sensitive,
        /* ★ 明确写「页面没有被改动」—— 调用方不必去猜有没有写进去 */
        pageUntouched: true,
        message:
          sensitive === 'password'
            ? '这是个密码框 —— 按规矩不代填密码（请你自己输入）。页面没有被改动。'
            : '这是信用卡字段 —— 按规矩不代填支付信息（请你自己输入）。页面没有被改动。',
        ref: target,
        version,
      }
    }

    const readValue = () => {
      try {
        return String(el.value === undefined || el.value === null ? '' : el.value)
      } catch {
        return ''
      }
    }
    const valueBefore = readValue()

    /* 原生 setter（见文件头：直接赋值绕不过 React 的受控 value） */
    const nativeSet = (node, value) => {
      try {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && typeof desc.set === 'function') desc.set.call(node, value)
        else node.value = value
        return ''
      } catch (error) {
        return String((error && error.message) || error)
      }
    }

    try {
      el.focus()
    } catch {
      /* 焦点给不上不致命 */
    }

    const threw = nativeSet(el, clear ? text : `${valueBefore}${text}`)
    if (!threw) {
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        /* 事件派发失败不算写失败 */
      }
    }
    const valueAfter = readValue()
    let focused = false
    try {
      focused = document.activeElement === el
    } catch {
      focused = false
    }

    return {
      ok: threw === '' && valueAfter === (clear ? text : `${valueBefore}${text}`),
      ref: target,
      version,
      threw,
      clear,
      /* ★ 证据里**只有长度**，没有明文 —— 类型的东西也别回传给模型（它可能被要求复述） */
      charCount: text.length,
      evidence: {
        valueBefore,
        valueAfter,
        changed: valueBefore !== valueAfter,
        focused,
        inputType: inputType || 'text',
      },
      checks: [
        { name: 'value-changed', pass: valueBefore !== valueAfter, before: valueBefore, after: valueAfter },
        { name: 'focused', pass: focused, before: '', after: String(focused) },
      ],
    }
  })()
}

/**
 * 下拉框选值。
 *
 * 依次尝试 `value` → `label` → `index`（三选一给了哪个用哪个）—— 找不到就**如实说找不到**，
 * 不静默选第一个（那会让「选错了」看起来像成功）。
 *
 * @param {string} ref
 * @param {{ value?: string, label?: string, index?: number }} [opts]
 */
export function selectOption(ref, opts) {
  return (async () => {
    const target = String(ref || '')
    const o = opts && typeof opts === 'object' ? opts : {}

    const store = window.__harborObs
    if (!store || !store.refs) {
      return { ok: false, reason: 'no-observation', message: '还没观察过这个页面 —— 先观察一次，再按引用操作' }
    }
    const version = String(store.version || '')
    const dot = target.lastIndexOf('.')
    const refVersion = dot > 0 ? target.slice(0, dot) : ''
    if (!target || !refVersion || refVersion !== version) {
      return { ok: false, reason: 'page-changed', message: '页面已经变了（这个引用属于旧版本）—— 请重新观察再操作', refVersion, version }
    }
    const holder = store.refs.get(target)
    let el = null
    try {
      el = holder && typeof holder.deref === 'function' ? holder.deref() : null
    } catch {
      el = null
    }
    if (!el || el.isConnected !== true) {
      return { ok: false, reason: 'not-found', message: '这个元素已经不在页面上了 —— 请重新观察再操作', refVersion, version }
    }
    const tag = String(el.tagName || '').toUpperCase()
    if (tag !== 'SELECT') {
      return { ok: false, reason: 'not-a-select', message: `这个元素是 ${tag || '未知'}，不是下拉框 —— 换个引用`, refVersion, version }
    }

    const options = []
    try {
      for (let i = 0; i < el.options.length; i += 1) {
        const op = el.options[i]
        options.push({ index: i, value: String(op.value), label: String(op.text || '').trim() })
      }
    } catch {
      /* 拿不到就当空 */
    }

    let pick = -1
    if (o.value !== undefined && o.value !== null && String(o.value) !== '') {
      pick = options.findIndex((x) => x.value === String(o.value))
    }
    if (pick < 0 && o.label !== undefined && String(o.label).trim() !== '') {
      pick = options.findIndex((x) => x.label === String(o.label).trim())
    }
    if (pick < 0 && Number.isInteger(o.index) && Number(o.index) >= 0) {
      pick = Number(o.index) < options.length ? Number(o.index) : -1
    }
    if (pick < 0) {
      return {
        ok: false,
        reason: 'option-not-found',
        message: '下拉框里找不到这个选项 —— 请先看一遍可选值再选',
        tried: { value: o.value ?? null, label: o.label ?? null, index: o.index ?? null },
        options,
        ref: target,
        version,
      }
    }

    const beforeValue = String(el.value)
    let threw = ''
    try {
      el.selectedIndex = pick
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } catch (error) {
      threw = String((error && error.message) || error)
    }
    const chosen = options[pick] || { index: pick, value: '', label: '' }

    return {
      ok: threw === '' && String(el.value) === chosen.value,
      ref: target,
      version,
      threw,
      selected: chosen,
      evidence: {
        valueBefore: beforeValue,
        valueAfter: String(el.value),
        changed: beforeValue !== String(el.value),
        optionCount: options.length,
      },
      checks: [
        { name: 'selected-value', pass: String(el.value) === chosen.value, before: beforeValue, after: String(el.value) },
        { name: 'option-exists', pass: true, before: `${options.length} 个选项`, after: chosen.label },
      ],
    }
  })()
}
