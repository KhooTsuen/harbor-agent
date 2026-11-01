/**
 * 下行指令（主进程 → 扩展，等回执）—— M04 起
 *
 * 通道**早就存在**（`ext-bridge` 的 push → host → 扩展），过去只推流式分片；这里把
 * 同一条当**指令**用：call() → push(PAGE_COMMAND) → SW 执行 → 回 page:result →
 * 按 id 配对。**零新增 IPC 通道、零新增帧类型**。⚠️ 本模块**不 require electron**。
 */

const P = require('./ext-protocol.cjs')
/* M04 剩余 + M05：动作层 / 标签页层 / 敏感判定（各有唯一一处实现，这里只调） */
const { createActions } = require('./ext-actions.cjs')
const { createTabs } = require('./ext-tabs.cjs')
const gate = require('./ext-gate.cjs')
/* ref 解析（纯函数，唯一一处判定）—— 本文件再导出，调用点不用改 */
const { inspectRef } = require('./ext-ref.cjs')

/** 等回执的期限（浏览器没开 / 扩展被回收 → 给带 code 的人话，不干等） */
const COMMAND_TIMEOUT_MS = 15000


/**
 * @param {{ getBridge: () => object, log?: object, land?: Function, confirm?: Function }} deps
 *   `land` / `confirm` 由装配处注入（渲染+落盘 / 弹既有确认卡），免得内核互相 require。
 */
function createCommand(deps) {
  const bridgeOf = deps.getBridge ?? (() => null)
  const log = deps.log
  const land = typeof deps.land === 'function' ? deps.land : null
  /*
   * ★ M04-3 敏感操作确认：**由装配处注入**（与 `land` 同一路子）——
   *   确认卡要 `emit`，而 emit 只有 `electron/handlers/` 有（见 chat.cjs:143）。
   *   没注入时 `click` 会**保守拒绝**（fail-closed），绝不放行。
   */
  const confirm = typeof deps.confirm === 'function' ? deps.confirm : null

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
    /*
     * ★ `markdown` 要一起带出去：`tools/edge-*.cjs` 用它讲给模型听 ——
     *   「操作结果 → 文本」只有 `ext-ops.ingestAction` 那一处实现，工具**不自己再格式化**
     *   （两份必然漂，硬约束 #9）。漏了这一行，工具就只能回原始 JSON（真机逮到过）。
     */
    return {
      ok: Boolean(payload && payload.ok === true),
      result: payload,
      sessionId: saved.sessionId,
      chars: saved.chars,
      truncated: saved.truncated === true,
      markdown: typeof saved.markdown === 'string' ? saved.markdown : '',
    }
  }

  /** 发一条指令并等回执（`command` = 扩展侧指令名，如 `get-elements`） */
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

  /** 扩展回来的回执（ext-ops 把 page:result 分派到这里）。没配对上不算错（可能是迟到的）。 */
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
   * `browser.click`（M04）。三道闸，缺一不可：
    *   ① **点前**拿当前版本号，不对就**根本不发指令**（发了才说过期没用）
    *   ② **★ 敏感操作确认**（M04-3）：判定在 ext-gate（唯一一处），卡走既有 chat-confirm；
    *      拒绝/超时 → **不点**，明确回「页面没被改动」。③ 结果带状态证据 —— 「点了」≠「生效」。
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
      /* ★ 引用失效：**没发指令**。但也要落一笔 —— 得让人看到「为什么没点下去」 */
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

    /* ② ★ 敏感操作确认（M04-3）—— 判定在 `ext-gate.cjs`，这里只执行它的结论 */
    const el = parsed.element && typeof parsed.element === 'object' ? parsed.element : {}
    const verdict = gate.judge(el)
    if (verdict.needsConfirm) {
      if (typeof confirm !== 'function') {
        /* ★ 没接线就**保守拒绝**（fail-closed）：不能因为装配漏了就把这道闸绕过去 */
        log?.warn?.('扩展通道：敏感操作需要确认，但确认通道没接线 —— 按「不执行」处理')
        return fail(P.ERR.DENIED, '这一步属于敏感操作，需要你确认；但确认窗口这会儿用不了 —— 已按「不执行」处理')
      }
      const allowed = await confirm(gate.describe(el, { url: cur.url, title: cur.title }), { ref })
      if (allowed !== true) {
        /* 拒绝 / 超时：**没点**。落一笔，并明确说「页面没被改动」 */
        const denied = {
          ok: false,
          reason: 'denied-by-user',
          ref,
          sensitive: true,
          pageUntouched: true,
          message: '用户取消了这一步 —— **没有点击**，页面没有被改动。',
        }
        return {
          ...landAction('click', denied, { ref, durationMs: 0, sessionTitleHint: payload.sessionTitleHint, confirmed: false }),
          error: { code: P.ERR.DENIED, message: denied.message },
        }
      }
    }

    /* ③ 发指令。pageVersion 供页面引用校验；去重按动作、引用与载荷判定。 */
    const t0 = Date.now()
    const res = await call('click', { ref, settleMs, pageVersion: cur.pageVersion })
    const durationMs = Date.now() - t0
    if (!res) return fail(P.ERR.INTERNAL, '浏览器没回可用的结果')
    /* 「根本没送出去」= 链路问题（浏览器没开 / 超时）：没什么可落的，直接回错 */
    if (res.ok !== true && res.error && !res.reason) return res
    /*
     * 其余**都算「一次操作的结果」**（成功 / 点了但证据没采到）—— 统一落盘 + 统一形状：
     * 浏览器回来的东西放在 `result` 里（自检与真机各抓到一次「两种形状取空」的坑）。
     */
    return landAction('click', res, { ref, durationMs, sessionTitleHint: payload.sessionTitleHint, confirmed: verdict.needsConfirm })
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

  /*
   * ── M04 剩余 + M05：其余动作**全部转给专门模块**（`ext-command.cjs` 已经贴线，
   *    这批不再往里堆实现）。每个新能力都是薄转调 —— 校验与渲染都在那边。
   *    `checkRef` 用同一份实现（`ext-actions` 里调 `getElements` + `inspectRef`）。
   */
  const actions = createActions({ call, getElements, landAction })
  const tabs = createTabs({ call, landAction })

  return {
    readCurrent: () => call('read-current'),
    getElements,
    click,
    verify,
    /* M04 剩余 */
    type: (payload) => actions.type(payload),
    select: (payload) => actions.select(payload),
    scroll: (payload) => actions.scroll(payload),
    wait: (payload) => actions.wait(payload),
    navigate: (payload) => actions.navigate(payload),
    /* M04 补齐：clear / focus / key */
    clear: (payload) => actions.clear(payload),
    focus: (payload) => actions.focus(payload),
    key: (payload) => actions.key(payload),
    /* M05 */
    tabsList: () => tabs.list(),
    tabsSearch: (payload) => tabs.search(payload),
    tabsActivate: (payload) => tabs.activate(payload),
    tabsCreate: (payload) => tabs.create(payload),
    tabsClose: (payload) => tabs.close(payload),
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
