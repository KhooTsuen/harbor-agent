/**
 * M04 第 2 步：受控操作（click / verify）的**注入函数**
 *
 * ── 两个函数：按引用点一下（带状态证据）/ 读状态比对期望 ──────
 *
 * ── ★★ 自包含铁律（M03 §8.1，对 M04 同样成立）────────────────
 *
 * `executeScript({ func })` 会把它 `toString()` 后注入页面 —— 函数体里**只能**用
 * 自己的参数 / 局部变量 / 嵌套函数；引用了模块级东西 → 注入后 `ReferenceError`。
 * 而**单测抓不到**（Node 里 require 时一切都在），**只有真机现形**。所以辅助函数
 * 一律嵌套在函数体内；自检有静态断言扫「常量名泄漏进函数体」。
 *
 * ── ★ 「点了」≠「生效」（用户定的硬要求）─────────────────────
 *
 * `clickElement` **不返回**「点击成功」了事 —— 它带一份**可读的结构化证据**：
 * URL / 标题 / 节点数 / 正文字数 的前后对比 + 目标元素是否还在。
 * 调用方（模型）据此判断点击有没有产生效果，而不是信一个 `ok:true`。
 *
 * ★ 为什么证据用**可读的数字**而不是哈希：哈希能说「变了」，说不出**怎么变**；
 *   而模型要据此决定下一步。「12 节点 → 14 节点」比「a1b2 → c3d4」有用得多。
 *   （另：也不会为了算哈希在第二个文件里复制一份 FNV —— 硬约束 #9。）
 *
 * ── 引用失效保护 ─────────────────────────────────────────────
 *
 * 点之前**先校验版本号**（ref 前缀 ≠ 当前登记版本 → 立即拒绝 + 要求重新观察），
 * 口径与主进程的 `inspectRef` 同一套（版本号 + 列表里有没有）。
 */

/* global window, document, location */

/**
 * 按引用点一个元素。
 *
 * @param {string} ref M03 发的引用，形如 `60684574.3`
 * @param {{ settleMs?: number }} [opts] 点完等多久再采证据（给 SPA 一点反应时间）
 */
export function clickElement(ref, opts) {
  return (async () => {
    const target = String(ref || '')
    const settle = Math.max(0, Math.min(Number((opts && opts.settleMs) || 400), 5000))
    /** 等一会儿（点完页面常常是异步变的） */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    /** 采一份「可读的状态快照」—— 前后各一次，diff 就是证据 */
    const snap = () => {
      let nodes = -1
      let textLen = -1
      try {
        nodes = document.querySelectorAll('*').length
      } catch {
        nodes = -1
      }
      try {
        textLen = document.body ? String(document.body.innerText || '').length : 0
      } catch {
        textLen = -1
      }
      return {
        url: String(location.href),
        title: String(document.title || ''),
        nodes,
        textLen,
      }
    }

    const store = window.__harborObs
    if (!store || !store.refs) {
      return {
        ok: false,
        reason: 'no-observation',
        message: '还没观察过这个页面 —— 先观察一次，再按引用操作',
      }
    }

    /* ★ 校验一：版本号（ref 前缀 vs 当前登记版本）—— 与主进程 inspectRef 同一口径 */
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

    /* ★ 校验二：ref 在不在登记表里 + 元素是否还挂在文档上 */
    const holder = store.refs.get(target)
    let el = null
    try {
      el = holder && typeof holder.deref === 'function' ? holder.deref() : null
    } catch {
      el = null
    }
    if (!el || el.isConnected !== true) {
      return {
        ok: false,
        reason: 'not-found',
        message: '这个元素已经不在页面上了 —— 请重新观察再操作',
        refVersion,
        version,
      }
    }

    const before = snap()
    let threw = ''
    try {
      el.click()
    } catch (error) {
      threw = String((error && error.message) || error)
    }
    /* 抛了就别等 —— 页面多半没动 */
    if (!threw) await sleep(settle)
    const after = snap()

    let stillThere = false
    try {
      stillThere = el.isConnected === true
    } catch {
      stillThere = false
    }
    const urlChanged = before.url !== after.url
    const titleChanged = before.title !== after.title
    const domChanged = before.nodes !== after.nodes || before.textLen !== after.textLen

    return {
      ok: threw === '',
      ref: target,
      version,
      threw,
      settledMs: settle,
      /*
       * ★★ 这一份就是「状态证据」。**注意它不叫 success** ——
       *   点了有没有用，由调用方（模型）看这四个信号自己判断。
       */
      evidence: {
        urlChanged,
        urlBefore: before.url,
        urlAfter: after.url,
        titleChanged,
        titleBefore: before.title,
        titleAfter: after.title,
        domChanged,
        nodesBefore: before.nodes,
        nodesAfter: after.nodes,
        textLenBefore: before.textLen,
        textLenAfter: after.textLen,
        targetStillThere: stillThere,
      },
      /* 逐条摆出来（模型/人都好读）：哪条变了、哪条没变 */
      checks: [
        { name: 'url-changed', pass: urlChanged, before: before.url, after: after.url },
        { name: 'title-changed', pass: titleChanged, before: before.title, after: after.title },
        {
          name: 'dom-changed',
          pass: domChanged,
          before: `${before.nodes} 节点 / ${before.textLen} 字`,
          after: `${after.nodes} 节点 / ${after.textLen} 字`,
        },
        { name: 'target-still-there', pass: stillThere, before: true, after: stillThere },
      ],
      at: Date.now(),
    }
  })()
}

/**
 * 按期望验页面状态（不改页面，只读）。
 *
 * 期望的每一条**独立判定**，最后 `matched` = 有期望且**全部**通过。
 *
 * @param {{
 *   url?: string, urlEquals?: string,
 *   text?: string, textGone?: string,
 *   selector?: string, selectorGone?: string,
 *   ref?: string, refGone?: string,
 *   settleMs?: number,
 * }} expect
 */
export function verifyPage(expect) {
  return (async () => {
    const want = expect && typeof expect === 'object' ? expect : {}
    const settle = Math.max(0, Math.min(Number(want.settleMs || 0), 5000))
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    if (settle > 0) await sleep(settle)

    let text = ''
    try {
      text = document.body ? String(document.body.innerText || '') : ''
    } catch {
      text = ''
    }
    const href = String(location.href)
    /** 数选择器命中的元素（非法选择器 → 返回 -1，不抛） */
    const countOf = (sel) => {
      try {
        return document.querySelectorAll(String(sel)).length
      } catch {
        return -1
      }
    }
    /** 按 ref 判在不在（要版本对得上 + 元素还挂着） */
    const refState = (r) => {
      const store = window.__harborObs
      if (!store || !store.refs) return { found: false, why: 'no-observation' }
      const target = String(r || '')
      const version = String(store.version || '')
      const dot = target.lastIndexOf('.')
      const refVersion = dot > 0 ? target.slice(0, dot) : ''
      if (!refVersion || refVersion !== version) return { found: false, why: 'page-changed' }
      const holder = store.refs.get(target)
      let el = null
      try {
        el = holder && typeof holder.deref === 'function' ? holder.deref() : null
      } catch {
        el = null
      }
      return el && el.isConnected === true ? { found: true, why: '' } : { found: false, why: 'gone' }
    }

    const checks = []
    if (want.url) {
      const needle = String(want.url)
      checks.push({ name: 'url-contains', expected: needle, actual: href, pass: href.includes(needle) })
    }
    if (want.urlEquals) {
      const exact = String(want.urlEquals)
      checks.push({ name: 'url-equals', expected: exact, actual: href, pass: href === exact })
    }
    if (want.text) {
      const needle = String(want.text)
      checks.push({
        name: 'text-contains',
        expected: needle,
        actual: text.includes(needle) ? '包含' : '不包含',
        pass: text.includes(needle),
      })
    }
    if (want.textGone) {
      const needle = String(want.textGone)
      checks.push({
        name: 'text-gone',
        expected: needle,
        actual: text.includes(needle) ? '还在' : '没有了',
        pass: !text.includes(needle),
      })
    }
    if (want.selector) {
      const sel = String(want.selector)
      const n = countOf(sel)
      checks.push({ name: 'selector-appears', expected: sel, actual: n < 0 ? '选择器不合法' : `${n} 个`, pass: n > 0 })
    }
    if (want.selectorGone) {
      const sel = String(want.selectorGone)
      const n = countOf(sel)
      checks.push({
        name: 'selector-gone',
        expected: sel,
        actual: n < 0 ? '选择器不合法' : `${n} 个`,
        pass: n === 0,
      })
    }
    if (want.ref) {
      const st = refState(want.ref)
      checks.push({
        name: 'ref-appears',
        expected: String(want.ref),
        actual: st.found ? '在' : `不在（${st.why || '未知'}）`,
        pass: st.found,
      })
    }
    if (want.refGone) {
      const st = refState(want.refGone)
      checks.push({
        name: 'ref-gone',
        expected: String(want.refGone),
        actual: st.found ? '还在' : '没有了',
        pass: !st.found,
      })
    }

    return {
      ok: true,
      /* 有期望且全部通过才算 matched —— 一条期望都没给时是 false（不假装验过） */
      matched: checks.length > 0 && checks.every((c) => c.pass),
      checks,
      url: href,
      title: String(document.title || ''),
      at: Date.now(),
    }
  })()
}
