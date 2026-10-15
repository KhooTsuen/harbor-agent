/**
 * M04：执行主进程下发的**指令**（从 `service-worker.js` 拆出来）
 *
 * ── 指令从哪来 ───────────────────────────────────────────────
 *
 * 主进程 `ext-command.cjs` 的 `call()` → `push(page:command)`
 *   → host 转帧 → `native.js` 收到 push → **交给这里**。
 *
 * 这是本扩展**第一条「主进程发起」的页面动作**（M03 全是「用户点了才做」）——
 * 但**规矩没变**：仍然只动**前台当前标签**（`lib/active-tab.js`），不遍历后台。
 *
 * ── ★ 执行完必须回执（`page:result`）──────────────────────────
 *
 * 主进程那边 `handleResult()` 按 `id` 配对；**不回就是 15 秒超时**
 * （用户看到「浏览器没在 15 秒内回话」）。所以成功失败**都要回** ——
 * 连不上了才作罢（那时主进程本来就会超时）。
 */

/* global chrome */

import { requestHost } from './native.js'
import { resolveActiveTab } from './active-tab.js'
import { clickElement, verifyPage } from './act.js'
/* M04 剩余：填表 / 滚动 / 等待 / 导航（拆到 act-run，见它的文件头） */
import { runPageAction } from './act-run.js'
/* M05：标签页三件（不注入任何东西，也不依赖「前台标签」） */
import { listTabs, searchTabs, activateTab } from './tabs-run.js'
/* get-elements：**复用 M03 的采集器**（同一个注入函数 / 同一套版本号 / 同一套 ref 登记）——
   绝不新写第二个（那必然漂，硬约束 #9）。 */
import { collectPageContext } from './observe.js'

/** 往页面里注入一个**自包含**函数并取回它的返回值（自包含理由见 `lib/act.js` 文件头） */
async function inject(tabId, fn, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args })
  return results && results[0] ? results[0].result : null
}

/**
 * 注入 + **超时上限**。
 *
 * ── ★ 为什么必须加（M04 真机逮到，比「拿不到结果」更严重）──────
 *
 * 点击触发**页面导航**时，注入的那段代码随页面卸载被销毁 —— 它的 promise
 * **永远不 resolve**。于是 `runCommand` 卡在 `await` 上 → **回执永远发不出去**
 * → 主进程白等 **15 秒**才超时（用户看到「浏览器没在 15 秒内回话」，而浏览器
 * 好端端的、那一下也真的点出去了）。
 *
 * 所以这里给一个**比主进程超时短**的上限：超了就当作「没结果」，交给调用方
 * 用 `chrome.tabs.get` 读 url 前后对比去**判定**是不是导航（不猜）。
 *
 * @returns {Promise<object|null|{__timeout:true}>}
 */
async function injectBounded(tabId, fn, args, timeoutMs) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  })
  try {
    return await Promise.race([inject(tabId, fn, args), guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 点击 + **同时监听「页面开始导航」**（M04-3 修「白等 15 秒」）。
 *
 * ── ★ 为什么不能用 `injectBounded` 那种「超时后再判」────────────
 *
 * 点击触发导航时，注入的上下文随页面卸载被销毁 —— 注入 promise **永远不 resolve**。
 * 上一版用「注入超时（settle+5s）→ 再 `tabs.get` 判导航」：要白等 5 秒多，
 * 用户看到「浏览器没回话」，而页面其实早就跳了。
 *
 * 现在**同时**挂一个 `chrome.tabs.onUpdated`（`status === 'loading'`）监听：
 * 注入返回 OR 页面开始导航，**哪个先到返回哪个**。导航通常 1~2 秒内触发 loading，
 * 于是「点会跳转的按钮」1~2 秒内就有结果，而不是干等超时。
 *
 * @returns {Promise<object|null|{__timeout:true}|{__navigating:true}>}
 */
async function clickWithNavWatch(tabId, ref, settleMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (val) => {
      if (settled) return
      settled = true
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated)
      } catch {
        /* 忽略 */
      }
      resolve(val)
    }
    const onUpdated = (tid, changeInfo) => {
      if (tid !== tabId) return
      if (changeInfo && changeInfo.status === 'loading') finish({ __navigating: true })
    }
    try {
      chrome.tabs.onUpdated.addListener(onUpdated)
    } catch {
      /* 不支持就不监听，退化成注入超时兜底 */
    }
    inject(tabId, clickElement, [String(ref), { settleMs }])
      .then((r) => finish(r === undefined ? null : r))
      .catch(() => finish(null))
    /* 兜底：注入没返回、也没监到导航（点了个不跳转但卡住的元素） */
    setTimeout(() => finish({ __timeout: true }), settleMs + 5000)
  })
}

/**
 * 跑一条指令，回执，返回结果。
 *
 * @param {{ id?: string, command?: string, payload?: object }} [payload]
 */
export async function runCommand(payload) {
  const id = String(payload?.id ?? '')
  const command = String(payload?.command ?? '')
  const args = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {}
  const reply = async (result) => {
    try {
      await requestHost('page-result', { id, result })
    } catch {
      /* 与 Harbor 断开了：主进程会走超时，不是这一层的错 */
    }
    return result
  }

  /*
   * ★ M05：tabs 三件**不依赖前台标签**（它们碰的是标签页本身）—— 放在
   *   `resolveActiveTab()` **之前**。否则「侧边栏页在前台」时会被那句
   *   「该页面不支持读取」挡住，而 tabs.list 根本不需要看任何页面。
   */
  if (command === 'tabs-list' || command === 'tabs-search' || command === 'tabs-activate') {
    if (command === 'tabs-list') return reply(await listTabs())
    if (command === 'tabs-search') return reply(await searchTabs(args.query))
    return reply(await activateTab(args))
  }

  let result = { ok: false, error: `不认识的指令：${command || '(空)'}` }

  try {
    const target = await resolveActiveTab()
    if (!target.ok) {
      /* 「读不到当前标签」时**照样**要回执 —— 那边在等 */
      result = { ok: false, error: target.error }
    } else if (command === 'get-elements') {
      /*
       * ★ M04-1 当时只做了**上行**（侧边栏点按钮）—— 而下行（主进程来要）是 M04-2
       *   的 click 第一步就依赖的（点之前先要当前版本号校验引用）。所以这里补上。
       * 复用 `collectPageContext`（M03 那份），结果包一层 `ok:true` —— 下行回执
       * 的形状是 `{ok:true, ...}`（主进程 `ext-command.getElements` 按它判）。
       */
      const maxItems = Number(args.maxItems) > 0 ? Math.min(Number(args.maxItems), 200) : 60
      const raw = await injectBounded(target.tab.id, collectPageContext, [{ maxItems, maxSelection: 0 }], 8000)
      result =
        raw && typeof raw === 'object' && raw.__timeout !== true
          ? { ok: true, ...raw }
          : { ok: false, error: '页面没有返回元素列表' }
    } else if (command === 'click') {
      const beforeUrl = String(target.tab.url || '')
      const settle = Math.max(0, Math.min(Number(args.settleMs) || 400, 5000))
      const raw = await clickWithNavWatch(target.tab.id, String(args.ref ?? ''), settle)

      if (raw && raw.__navigating === true) {
        /*
         * ★★ 导航信号先到（1~2 秒内）—— M04-3 修「白等 15 秒」。
         *   点会跳转的按钮，注入上下文随页面卸载被销毁、结果回不来；但「页面开始跳转」
         *   这个事实本身就是证据。如实说清：不代表没点上，别让模型去重试（会点两次）。
         */
        result = {
          ok: false,
          reason: 'navigating',
          navigated: true,
          urlBefore: beforeUrl,
          message: '点击后页面开始跳转，状态证据没来得及采 —— **不代表没点上**。请用 browser.verify 确认结果。',
          timedOut: false,
        }
      } else if (raw && raw.__timeout !== true) {
        result = raw
      } else {
        /*
         * 兜底：注入超时、也没监到导航（点了个不跳转但卡住的元素）——
         * 仍用 `tabs.get` 读 url 前后对比**判定**（不猜）。
         */
        let afterUrl = ''
        try {
          const t = await chrome.tabs.get(target.tab.id)
          afterUrl = String((t && t.url) || '')
        } catch {
          /* 标签没了也算一种「变了」 */
        }
        const navigated = Boolean(afterUrl) && afterUrl !== beforeUrl
        result = {
          ok: false,
          reason: 'no-result',
          navigated,
          urlBefore: beforeUrl,
          urlAfter: afterUrl,
          message: navigated
            ? `点击后页面跳转到了 ${afterUrl}，所以状态证据没来得及采 —— **不代表没点上**。请用 browser.verify 确认结果。`
            : '点击指令发出去了，但页面没把结果送回来 —— 请重新观察一次再看。',
          timedOut: raw && raw.__timeout === true,
        }
      }
    } else if (command === 'verify') {
      const raw = await injectBounded(target.tab.id, verifyPage, [args.expect || {}], 8000)
      result = raw && typeof raw === 'object' && raw.__timeout !== true ? raw : { ok: false, error: '页面没返回验证结果（可能卡住或正在跳转）' }
    } else {
      /* M04 剩余：type / select / scroll / wait / navigate（转给 act-run；null = 不认识） */
      const handled = await runPageAction(command, target.tab, args)
      if (handled) result = handled
    }
  } catch (error) {
    result = { ok: false, error: `执行不了这个操作：${(error && error.message) || error}` }
  }
  return reply(result)
}
