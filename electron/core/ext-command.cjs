/**
 * 下行指令：主进程 → 浏览器扩展，并等回执（M04）
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────
 * M03 的方向是「扩展 → 主进程」；M04 要做「主进程 → 扩展」：**模型**决定要点哪个
 * 元素，主进程得让浏览器去执行。下行的物理通道**早就存在**（`ext-bridge.cjs` 的
 * `push` → host 转帧 → 扩展），过去只用来推流式分片 —— 这里把同一条通道当**指令**用：
 *
 *   call() → bridge.push(PAGE_COMMAND, {id, command, payload})
 *     → host 转给扩展 → SW 执行 → 回 {type:'page:result', id, result}
 *     → ext-ops 分派到 handleResult() → 按 id 配对 → resolve
 *
 * 所以**零新增 IPC 通道、零新增帧类型**（「推送 vs 应答」仍是「有没有 id」）。
 * ref 解析（三条判定）放**主进程**：它是纯数据比较、不碰 DOM，自检能直接覆盖。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const P = require('./ext-protocol.cjs')

/** 等回执的期限（浏览器没开 / 扩展被回收 → 给带 code 的人话，不干等） */
const COMMAND_TIMEOUT_MS = 15000

/**
 * 解析一个元素引用（**纯函数** —— 三条判定，自检钉的就是它）。
 *
 * ref 形态（M03 定的）：`<pageVersion>.<序号>`，如 `60684574.3`。
 *
 *   ① 版本对不上 → 引用失效（`page-changed`）—— **必须重新观察**，否则会误点
 *   ② 版本对得上、ref 在列表里 → 有效，附它**当前**的状态
 *   ③ 版本对得上、ref 不在列表里 → 元素没了 / 不再可交互（`not-found`）
 *
 * ★ 为什么不用「deref 元素还在不在」当判据：deref 只能证明元素还在内存，
 *   **证明不了页面没变** —— 而防误点靠的正是后者。
 *
 * @param {string} ref
 * @param {string} currentVersion
 * @param {Array<{ref?: string}>} elements
 */
function inspectRef(ref, currentVersion, elements) {
  const want = String(ref ?? '')
  if (!want) return { kind: 'list', stale: false, element: null }
  const dot = want.lastIndexOf('.')
  const version = dot > 0 ? want.slice(0, dot) : want
  const cur = String(currentVersion ?? '')
  const found = (elements ?? []).find((e) => e && e.ref === want) ?? null
  if (version !== cur) {
    return { kind: 'stale', stale: true, reason: 'page-changed', version, currentVersion: cur, element: found }
  }
  if (!found) {
    return { kind: 'stale', stale: true, reason: 'not-found', version, currentVersion: cur, element: null }
  }
  return { kind: 'ok', stale: false, reason: '', version, currentVersion: cur, element: found }
}

/**
 * @param {{
 *   getBridge: () => ({ push?: (kind: string, payload: object) => { sent?: number } } | null),
 *   log?: { warn?: (m: string) => void, info?: (m: string) => void },
 *   land?: (kind: string, result: object, meta: object) => object,
 * }} deps
 *   `land` 由装配处注入（`register-handlers.cjs`）：把「操作结果」渲染成 markdown、
 *   过 `wrapWebText`、落进会话 —— **不在这里 require ext-ops / ext-observe**，
 *   免得两个内核模块互相 require（自检也要能单独跑这一个）。
 */
function createCommand(deps) {
  const bridgeOf = deps.getBridge ?? (() => null)
  const log = deps.log
  const land = typeof deps.land === 'function' ? deps.land : null

  /** 发出去、还没等到回执的指令：id → { resolve, timer }（并发安全） */
  const pending = new Map()
  let seq = 0

  const fail = (code, message) => ({ ok: false, error: { code, message } })

  /**
   * 把一次操作的结果交给落盘，并**统一返回形状**。
   *
   * ★ 一条规矩：**浏览器回来的东西一律放 `result`**；`error` 只留给「根本没执行」
   *   （引用失效被拒 / 浏览器没开）。第一版成功路径返回 `{ok:true, result}`、
   *   「点了但证据没采到」却返回**裸结果**，调用方按 `res.result.reason` 取到空
   *   （自检 + 真机各抓到一次假红）。成败以**结果自己的 ok** 为准（不是「落盘成功」）。
   */
  function landAction(kind, result, meta) {
    const payload = result && typeof result === 'object' ? result : null
    /* 落盘要 url / title（会话标题与审计用）—— 从结果里的证据取，取不到就空着 */
    const ev = payload && payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : {}
    const full = {
      ...meta,
      url: String((payload && (payload.urlAfter || payload.url)) || ev.urlAfter || ''),
      title: String((payload && (payload.titleAfter || payload.title)) || ev.titleAfter || ''),
    }
    const saved = land && payload ? land(kind, payload, full) || {} : {}
    return {
      ok: Boolean(payload && payload.ok === true),
      result: payload,
      sessionId: saved.sessionId,
      chars: saved.chars,
      truncated: saved.truncated === true,
    }
  }

  /**
   * 发一条指令并等回执。
   *
   * @param {string} command 扩展侧的指令名（如 `get-elements`）
   * @param {object} payload
   */
  function call(command, payload = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const bridge = bridgeOf()
      if (!bridge) {
        resolve(fail(P.ERR.NO_BROWSER, '扩展未连接 —— 请打开侧边栏'))
        return
      }
      const id = `cmd_${(seq += 1).toString(36)}_${Date.now().toString(36)}`
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(
          fail(
            P.ERR.TIMEOUT,
            `浏览器没在 ${Math.round(timeoutMs / 1000)} 秒内回话（页面可能卡住，或扩展被浏览器回收了）`,
          ),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, { resolve, timer })

      let sent = null
      try {
        sent = bridge.push?.(P.KIND.PAGE_COMMAND, { id, command, payload })
      } catch (error) {
        sent = null
        log?.warn?.(`下行指令发送失败：${error instanceof Error ? error.message : error}`)
      }
      if (!sent || !sent.sent) {
        clearTimeout(timer)
        pending.delete(id)
        resolve(fail(P.ERR.NO_BROWSER, '扩展未连接 —— 请打开侧边栏'))
      }
    })
  }

  /**
   * 扩展回来的回执 —— `ext-ops.cjs` 把 `page:result` 分派到这里。
   *
   * 没配对上不算错（可能是超时后迟到的回执）—— 只记一行日志。
   */
  function handleResult(payload) {
    const id = String(payload?.id ?? '')
    const entry = pending.get(id)
    if (!entry) {
      log?.warn?.(`下行指令收到一条迟到/无法配对的回执（id=${id || '(空)'}）`)
      return { ok: true, matched: false }
    }
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(payload?.result ?? fail(P.ERR.INTERNAL, '浏览器回来了，但没带结果'))
    return { ok: true, matched: true }
  }

  /**
   * `browser.getElements`（M04 第 1 步）。
   *
   * 复用 M03 的采集器（同一个注入函数、同一套版本号算法、同一套 ref 登记）——
   * 扩展侧只裁掉 selection / frames / shadow 再发回来。
   *
   * @param {{ ref?: string, maxItems?: number }} [payload]
   */
  async function getElements(payload = {}) {
    const ref = String(payload.ref ?? '')
    const maxItems = Number(payload.maxItems) > 0 ? Math.min(Number(payload.maxItems), 200) : 0
    const res = await call('get-elements', { ref, maxItems })
    if (!res || res.ok !== true) {
      return res && res.error ? res : fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    }
    const pageVersion = String(res.pageVersion ?? '')
    const elements = Array.isArray(res.elements) ? res.elements : []
    const parsed = inspectRef(ref, pageVersion, elements)
    if (parsed.stale) {
      const why = parsed.reason === 'page-changed' ? '页面已经变了（元素引用失效）' : '这个元素不在当前页面的可交互列表里'
      return {
        ok: false,
        error: { code: P.ERR.STALE_REF, message: `${why} —— 请重新观察页面再操作` },
        pageVersion,
        stale: true,
        reason: parsed.reason,
        ref,
      }
    }
    return {
      ok: true,
      url: String(res.url ?? ''),
      title: String(res.title ?? ''),
      pageVersion,
      ref,
      stale: false,
      elements: ref ? undefined : elements,
      element: ref ? parsed.element : undefined,
      stats: res.stats ?? null,
    }
  }

  /**
   * `browser.click`（M04）。
   *
   * ★ 两道闸，缺一不可：
   *   ① **点之前**先观察一次当前页面拿**当前**版本号；对不上就**根本不发指令**
   *      （点了才说「这个引用过期了」没用 —— 错的东西可能已经被点出去了）。
   *   ② 点完把扩展给的**状态证据**渲染出来（`renderAction`）—— 「点了」≠「生效」。
   * 落盘复用 `ingest` 那条链；网页内容依然过 `wrapWebText`（点完的页面文字同样不可信）。
   *
   * @param {{ ref?: string, settleMs?: number, sessionTitleHint?: string }} [payload]
   */
  async function click(payload = {}) {
    const ref = String(payload.ref ?? '')
    if (!ref) return fail(P.ERR.STALE_REF, '没给元素引用 —— 先用 browser.getElements 拿一个')
    const settleMs = Number(payload.settleMs) > 0 ? Math.min(Number(payload.settleMs), 5000) : 400

    /* ① 点之前先要一份「当前这版」—— 只为校验引用，不落盘 */
    const cur = await getElements({})
    if (!cur || cur.ok !== true) {
      return cur && cur.error ? cur : fail(P.ERR.NO_BROWSER, '拿不到当前页面，没法安全地点击')
    }
    const parsed = inspectRef(ref, cur.pageVersion, cur.elements ?? [])
    if (parsed.stale) {
      const why = parsed.reason === 'page-changed' ? '页面已经变了（你手上的引用是旧版本的）' : '这个元素不在当前页面的可交互列表里'
      /*
       * ★ 引用失效：**根本没发指令**。但也要**落一笔** —— 用户和模型都该看到
       *   「为什么这次没点下去」（一片安静比一条明确的失败更糟）。
       */
      const refused = {
        ok: false,
        reason: parsed.reason,
        ref,
        refVersion: parsed.version,
        version: cur.pageVersion,
        message: `${why} —— 请重新观察页面再点`,
      }
      return {
        ...landAction('click', refused, { ref, durationMs: 0, sessionTitleHint: payload.sessionTitleHint }),
        error: { code: P.ERR.STALE_REF, message: refused.message },
        refVersion: parsed.version,
        pageVersion: cur.pageVersion,
      }
    }

    /* ② 发指令（第一次真机用下行通道） */
    const t0 = Date.now()
    const res = await call('click', { ref, settleMs })
    const durationMs = Date.now() - t0
    if (!res) return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    /* 「根本没送出去」= 链路问题（浏览器没开 / 超时）：没什么可落的，直接回错 */
    if (res.ok !== true && res.error && !res.reason) return res
    /*
     * 其余**都算「一次操作的结果」**（成功 / 点了但证据没采到）—— 统一落盘 + 统一形状：
     * 浏览器回来的东西放在 `result` 里（自检与真机各抓到一次「两种形状取空」的坑）。
     */
    return landAction('click', res, { ref, durationMs, sessionTitleHint: payload.sessionTitleHint })
  }

  /**
   * `browser.verify`（M04 第 2 步）：读页面状态，逐条比对期望。**不改页面**（L1 读）。
   *
   * @param {{ expect?: object, sessionTitleHint?: string }} [payload]
   */
  async function verify(payload = {}) {
    const expect = payload.expect && typeof payload.expect === 'object' ? payload.expect : {}
    const t0 = Date.now()
    const res = await call('verify', { expect })
    const durationMs = Date.now() - t0
    if (!res) return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    if (res.ok !== true && res.error) return res
    return landAction('verify', res, { durationMs, sessionTitleHint: payload.sessionTitleHint })
  }

  return {
    getElements,
    click,
    verify,
    handleResult,
    /** 自检用：还有几条在途 */
    get pendingCount() {
      return pending.size
    },
    /** 自检用：直接调一次底层（不必构造 bridge） */
    _call: call,
  }
}

module.exports = { createCommand, inspectRef, COMMAND_TIMEOUT_MS }
