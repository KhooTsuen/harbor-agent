/**
 * 下行指令：主进程 → 浏览器扩展，并等回执（M04 第 1 步）
 *
 * ── 为什么要有这个模块（M03 与 M04 的根本差别）────────────────
 *
 * M03 的方向是「扩展 → 主进程」：用户点侧边栏按钮，扩展采集，送给主进程。
 * M04 要做「主进程 → 扩展」：**模型**决定要点哪个元素，主进程得让浏览器去执行。
 *
 * 下行的物理通道**早就存在**（`ext-bridge.cjs` 的 `push` → host 转帧 → 扩展），
 * 只是过去只用来推流式分片。这里把同一条通道当**指令**用：
 *
 *   这里 call() → bridge.push(PAGE_COMMAND, {id, command, payload})
 *     → host 转给扩展 → SW 执行 → 用既有 request 通道回 {type:'page:result', id, result}
 *     → ext-ops 分派到这里 handleResult() → 按 id 配对 → resolve
 *
 * 所以**零新增 IPC 通道、零新增帧类型**（「推送 vs 应答」仍是「有没有 id」）。
 *
 * ── 为什么 ref 解析（三条判定）放在**主进程**而不是页面里 ────────
 *
 * 它是**纯数据比较**（ref 字符串 vs 当前 pageVersion），不需要碰 DOM —— 放主进程
 * 就能被自检直接覆盖。页面里只做「采集 + 登记 ref」这一件事（M03 已有）。
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
 * }} deps
 */
function createCommand(deps) {
  const bridgeOf = deps.getBridge ?? (() => null)
  const log = deps.log

  /** 发出去、还没等到回执的指令：id → { resolve, timer }（并发安全） */
  const pending = new Map()
  let seq = 0

  const fail = (code, message) => ({ ok: false, error: { code, message } })

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
        resolve(fail(P.ERR.NO_BROWSER, '浏览器扩展没连上 —— 先在浏览器里打开 Harbor 扩展'))
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
        resolve(fail(P.ERR.NO_BROWSER, '浏览器扩展没连上（浏览器可能已关闭）'))
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

  return {
    getElements,
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
