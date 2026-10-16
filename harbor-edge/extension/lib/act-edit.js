/**
 * M04 补齐：**聚焦**与**键盘事件**的注入函数（从 `act-form.js` 分出来 —— 那边 264 行贴线）
 *
 * 为什么这两个要单独的文件：它们是「元素级编辑」的另一半 —— `act-form` 管**值**
 * （填 / 选），这里管**焦点与按键**（Enter / Tab / Escape 这类，React 组件与
 * 搜索框常常只认键盘）。放一起会破 300 行。
 *
 * ── ★★ 自包含铁律（M03 §8.1，对本文件同样成立）────────────────
 *
 * `chrome.scripting.executeScript({ func })` 会把这个函数 **`toString()` 序列化**
 * 后注入页面 —— 函数体里**只能**引用自己的参数、局部变量、嵌套函数；引用任何
 * **模块级**东西 → 注入后 `ReferenceError`。而**单测抓不到**（Node 里 require 时
 * 一切都在），只有真机现形。所以校验逻辑**逐字照抄** `act-form.js` 的写法
 * （两处校验：版本号 + 元素还在不在），不抽公共函数。
 *
 * ⚠️ `KeyboardEvent` 是**页面环境的全局**，不在「禁止引用」之列（同 `window` / `document`）。
 */

/* global window, document, KeyboardEvent, HTMLInputElement, HTMLTextAreaElement */

/**
 * 聚焦一个元素。
 *
 * @param {string} ref M03 发的引用，形如 `60684574.3`
 */
export function focusElement(ref) {
  return (async () => {
    const target = String(ref || '')
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

    /** 元素的可读名字（证据里要能看出「焦点给了谁」） */
    const nameOf = (node) => {
      if (!node) return ''
      try {
        const tag = String(node.tagName || '')
        const id = node.id ? `#${node.id}` : ''
        const ph = node.getAttribute ? node.getAttribute('placeholder') || '' : ''
        return `${tag}${id}${ph ? `(${ph})` : ''}`
      } catch {
        return ''
      }
    }

    const before = document.activeElement
    let threw = ''
    try {
      el.focus()
    } catch (error) {
      threw = String((error && error.message) || error)
    }
    const after = document.activeElement
    const focused = after === el

    return {
      ok: !threw,
      ref: target,
      reason: threw ? 'focus-failed' : '',
      message: threw ? `聚焦失败：${threw}` : '',
      evidence: {
        focused,
        /* ★ 证据是**可读的名字**：模型据此判断「焦点是不是给到了我想给的那个框」 */
        activeBefore: nameOf(before),
        activeAfter: nameOf(after),
      },
      version,
    }
  })()
}

/**
 * 派发一次键盘事件（默认 Enter）。
 *
 * ── 为什么三种事件都要派 ──────────────────────────────────────
 *
 * React / 各类组件库认的不一样：老代码认 `keypress`，新代码认 `keydown`，
 * 而「松开」也要给（有些组件在 `keyup` 上提交）。只派一种就会「有的页面管用、
 * 有的不管用」，而那种 bug 最难查。
 *
 * ★ 目标：给了 `ref` 就先聚焦它再往它上面派；没给就派给**当前焦点元素**，
 *   再兜底 `document.body`（Escape 关弹窗这类监听挂在 document 上）。
 *
 * @param {string} ref 可为空（空 = 用当前焦点）
 * @param {string} key 键名，如 `Enter` / `Tab` / `Escape`
 */
export function pressKey(ref, key) {
  return (async () => {
    const target = String(ref || '')
    const k = String(key || 'Enter')

    let el = null
    if (target) {
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
      try {
        el = holder && typeof holder.deref === 'function' ? holder.deref() : null
      } catch {
        el = null
      }
      if (!el || el.isConnected !== true) {
        return { ok: false, reason: 'not-found', message: '这个元素已经不在页面上了 —— 请重新观察再操作', refVersion, version }
      }
      try {
        el.focus()
      } catch {
        /* 焦点给不上不致命 —— 按键仍派给它 */
      }
    }

    const node = el || document.activeElement || document.body
    const nodesBefore = (() => {
      try {
        return document.querySelectorAll('*').length
      } catch {
        return -1
      }
    })()

    /** 三种事件 + 让 `event.key` 真的是那个键（有的组件按 key 分支） */
    const init = { key: k, code: k, bubbles: true, cancelable: true, composed: true }
    let threw = ''
    let dispatched = 0
    try {
      node.dispatchEvent(new KeyboardEvent('keydown', init))
      dispatched += 1
      node.dispatchEvent(new KeyboardEvent('keypress', init))
      dispatched += 1
      node.dispatchEvent(new KeyboardEvent('keyup', init))
      dispatched += 1
    } catch (error) {
      threw = String((error && error.message) || error)
    }

    /* 给组件一点反应时间（提交常常在 keydown 里发起） */
    await new Promise((r) => setTimeout(r, 300))

    const nodesAfter = (() => {
      try {
        return document.querySelectorAll('*').length
      } catch {
        return -1
      }
    })()
    const nameOf = (n) => {
      if (!n) return ''
      try {
        return `${String(n.tagName || '')}${n.id ? `#${n.id}` : ''}`
      } catch {
        return ''
      }
    }

    return {
      ok: !threw,
      ref: target,
      key: k,
      reason: threw ? 'key-failed' : '',
      message: threw ? `按键派发失败：${threw}` : '',
      evidence: {
        key: k,
        dispatched,
        target: nameOf(node),
        /* ★ 与 click 同一口径：给「怎么变」而不是「变没变」 */
        nodesBefore,
        nodesAfter,
        domChanged: nodesBefore !== nodesAfter,
      },
    }
  })()
}
