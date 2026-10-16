/**
 * M04 剩余：`type` / `select` / `scroll` / `wait` / `navigate` 的**主进程侧**
 *
 * ── 为什么从 `ext-command.cjs` 拆出来 ─────────────────────────
 *
 * 那边已有 getElements / click / verify（293 行贴线）。这五个动作再塞进去就是 400+。
 * 拆开后职责也清楚：**这边是「动作层」**（校验引用 → 发指令 → 渲染证据 → 落盘），
 * `ext-command.cjs` 只管通道（`call` / 回执配对 / `inspectRef`）。
 *
 * ── ★ 与 click **同一套路**（三条，缺一条就不一致）────────────
 *
 *   ① 要按引用的动作（type / select / scroll-with-ref）**先校验版本号** ——
 *      拿当前页面 + `inspectRef`，失效就**根本不发指令**（理由见 click 的注释：
 *      「发了才说过期」没用，错的东西可能已经动过了）。
 *   ② 结果里带**可读证据**（前后值），不只回 ok。
 *   ③ 渲染成 markdown 时**如实**：拒绝就说拒绝 + 页面未被改动；超时就说超时。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const P = require('./ext-protocol.cjs')
/* M04 补齐：渲染拆到 ext-act-render.cjs（这边加三个动作会破 300 行）。
   这里**再导出**那几个渲染器 —— 调用点（ext-observe / ext-ops）一个都不用改。 */
const R = require('./ext-act-render.cjs')
const { cell, kv, MAX_CHARS } = R

/** 通用：把「扩展侧给的 reason」翻成人话 + 统一到 STALE_REF（判据一处） */
function staleOr(res) {
  if (!res || typeof res !== 'object') return null
  if (res.reason === 'page-changed') {
    return {
      ok: false,
      error: { code: P.ERR.STALE_REF, message: '页面已经变了（你手上的引用是旧版本的） —— 请重新观察页面再操作' },
      reason: 'page-changed',
      refVersion: res.refVersion,
      pageVersion: res.version,
    }
  }
  if (res.reason === 'not-found') {
    return {
      ok: false,
      error: { code: P.ERR.STALE_REF, message: '这个元素不在当前页面的可交互列表里 —— 请重新观察页面再操作' },
      reason: 'not-found',
    }
  }
  return null
}

/**
 * 建这五个动作。
 *
 * @param {{
 *   call: (command: string, payload: object, timeoutMs?: number) => Promise<object>,
 *   getElements: (payload?: object) => Promise<object>,
 *   landAction: (kind: string, result: object, meta: object) => object,
 *   log?: { warn?: (m: string) => void },
 * }} deps
 */
function createActions(deps) {
  const call = deps.call
  const getElements = deps.getElements
  const landAction = deps.landAction

  const fail = (code, message) => ({ ok: false, error: { code, message } })

  /**
   * 按引用操作前的**统一前置校验**（与 click 同一口径）。
   *
   * @param {string} ref
   * @returns {Promise<object>} 通过时 `{ ok:true, pageVersion }`；否则原样带回失败对象
   */
  async function checkRef(ref) {
    const cur = await getElements({})
    if (!cur || cur.ok !== true) {
      return cur && cur.error ? cur : fail(P.ERR.NO_BROWSER, '拿不到当前页面，没法安全地操作')
    }
    /* getElements 内部已调 inspectRef：ref 失效时它自己就返回 ok:false + STALE_REF */
    if (cur.stale === true || (cur.error && cur.error.code === P.ERR.STALE_REF)) {
      return cur
    }
    return { ok: true, pageVersion: String(cur.pageVersion ?? '') }
  }

  /** 落盘 + 统一返回（与 ext-command 的 landAction 同一形状约定） */
  function done(kind, res, meta) {
    return landAction(kind, res, meta)
  }

  /**
   * `browser.type`：往输入框填文本。**敏感字段拒绝**（扩展侧先判、先拒）。
   */
  async function type(payload = {}) {
    const ref = String(payload.ref ?? '')
    if (!ref) return fail(P.ERR.STALE_REF, '没给元素引用 —— 先用 browser.getElements 拿一个')
    const pre = await checkRef(ref)
    if (pre.ok !== true) return pre

    const res = await call('type', {
      ref,
      text: String(payload.text ?? ''),
      clear: payload.clear !== false,
    })
    /* 敏感字段：**拒绝**，页面未被改动 —— 用专门的码，别混进「操作失败」 */
    if (res && res.reason === 'sensitive-field') {
      return landAction('type', res, { ref, denied: true, field: res.field })
    }
    const st = staleOr(res)
    if (st) return st
    if (!res || res.ok !== true) return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    return done('type', res, { ref })
  }

  /** `browser.select`：下拉框选值 */
  async function select(payload = {}) {
    const ref = String(payload.ref ?? '')
    if (!ref) return fail(P.ERR.STALE_REF, '没给元素引用 —— 先用 browser.getElements 拿一个')
    const pre = await checkRef(ref)
    if (pre.ok !== true) return pre

    const res = await call('select', { ref, value: payload.value, label: payload.label, index: payload.index })
    const st = staleOr(res)
    if (st) return st
    if (!res || res.ok !== true) {
      /* 「找不到这个选项」是正常业务分支（不是异常）—— 原样回，让调用方看见可选值 */
      if (res && res.reason === 'option-not-found') return landAction('select', res, { ref, notFound: true })
      return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    }
    return done('select', res, { ref })
  }

  /** `browser.scroll`：滚动（可按引用 / 到两端 / 按像素） */
  async function scroll(payload = {}) {
    const ref = String(payload.ref ?? '')
    /* 只有「按引用滚」才需要校验版本（滚文档不需要引用） */
    if (ref) {
      const pre = await checkRef(ref)
      if (pre.ok !== true) return pre
    }
    const res = await call('scroll', { ref, to: payload.to, dy: payload.dy })
    const st = staleOr(res)
    if (st) return st
    if (!res || res.ok !== true) return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    return done('scroll', res, { ref })
  }

  /** `browser.wait`：等条件满足（条件语义复用 `verify` —— 扩展侧轮询同一份实现） */
  async function wait(payload = {}) {
    const expect = payload.expect && typeof payload.expect === 'object' ? payload.expect : {}
    if (!Object.keys(expect).length) return fail(P.ERR.INTERNAL, '没给要等的条件 —— 至少给一条（见 browser.verify 的期望写法）')
    const res = await call('wait', { expect, timeoutMs: Number(payload.timeoutMs) || 10000 }, 70000)
    if (!res || typeof res !== 'object') return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.error && res.ok !== true) return res
    return done('wait', res, {})
  }

  /** `browser.navigate`：导航到指定地址（地址是否允许由**主进程的 net-policy** 先判） */
  async function navigate(payload = {}) {
    const url = String(payload.url ?? '').trim()
    if (!url) return fail(P.ERR.INTERNAL, '没给要去的地址')
    const res = await call('navigate', { url }, 30000)
    if (!res || typeof res !== 'object') return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.error && res.ok !== true) return res
    return done('navigate', res, {})
  }


  /**
   * `browser.clear`（M04 补齐）：清空输入框。
   *
   * ★ **不另写注入函数** —— 清空就是「填一个空串」（`type` 已支持 `clear`）。
   *   少一个注入函数 = 少一处会跟 `type` 漂的实现（硬约束 #9）。
   */
  async function clear(payload = {}) {
    const ref = String(payload.ref ?? '')
    if (!ref) return fail(P.ERR.STALE_REF, '没给元素引用 —— 先用 browser.getElements 拿一个')
    const pre = await checkRef(ref)
    if (pre.ok !== true) return pre
    const res = await call('clear', { ref })
    const st = staleOr(res)
    if (st) return st
    if (res && res.reason === 'sensitive-field') return landAction('clear', res, { ref, denied: true, field: res.field })
    if (!res || res.ok !== true) return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    return done('clear', res, { ref })
  }

  /**
   * `browser.focus`（M04 补齐）：聚焦元素 —— 键盘操作（Enter / 输入法）前常要先给焦点。
   * 与其它按引用的动作同口径：**先校验版本**，失效就根本不发指令。
   */
  async function focus(payload = {}) {
    const ref = String(payload.ref ?? '')
    if (!ref) return fail(P.ERR.STALE_REF, '没给元素引用 —— 先用 browser.getElements 拿一个')
    const pre = await checkRef(ref)
    if (pre.ok !== true) return pre
    const res = await call('focus', { ref })
    const st = staleOr(res)
    if (st) return st
    if (!res || res.ok !== true) return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    return done('focus', res, { ref })
  }

  /**
   * `browser.key`（M04 补齐）：派发键盘事件（默认 Enter）。
   *
   * `ref` 可空 —— 空就是「往当前焦点元素派」（Escape 关弹窗这类）。给了就先聚焦它。
   */
  async function key(payload = {}) {
    const ref = String(payload.ref ?? '')
    const k = String(payload.key ?? 'Enter')
    if (ref) {
      const pre = await checkRef(ref)
      if (pre.ok !== true) return pre
    }
    const res = await call('key', { ref, key: k })
    const st = staleOr(res)
    if (st) return st
    if (!res || res.ok !== true) return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    return done('key', res, { ref })
  }

  return { type, select, scroll, wait, navigate, clear, focus, key, checkRef }
}

/* 渲染器**再导出**：ext-observe / ext-ops 仍从本模块取 —— 拆分对调用点是透明的。 */
module.exports = {
  createActions,
  renderEvidence: R.renderEvidence,
  renderSensitive: R.renderSensitive,
  renderOptionNotFound: R.renderOptionNotFound,
  renderWait: R.renderWait,
  renderNavigate: R.renderNavigate,
}
