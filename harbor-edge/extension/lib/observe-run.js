/**
 * M03：执行「观察页面」这一步（从 `service-worker.js` 拆出来）
 *
 * ── 为什么拆 ─────────────────────────────────────────────────
 *
 * SW 已经贴 300 行红线，M03 这段（注入采集器 → 送主进程 → 落快照）有 60 来行。
 * 拆出来还顺带把「页面动作」这类东西归了位：`readActivePage` 留在 SW 里（Phase 2
 * 的老代码，一个字节不动），M03 新增的走这里。
 *
 * ⚠️ 只读**前台当前标签**、**只由用户点那一下发起** —— 与 read-page 同规矩
 *   （拿标签那一段共用 `lib/active-tab.js`，判据只有一处）。
 *
 * ★ 2026-10-21：观察结果**不再落会话** → 走 `page:context` 那条（写「页面上下文槽」），
 *   由主进程每轮注入提示词。用户原话：「不要占用对话流，相当于提示词那一类的植入进去」。
 */

/* global chrome */

import { requestHost } from './native.js'
import { resolveActiveTab, stillActiveTab } from './active-tab.js'
import { collectPageContext } from './observe.js'
import { checkSite } from './site-policy.js'
import { contextAllowed } from './context-gate.js'
import { waitForStablePage } from './page-text.js'

/**
 * 结构化观察当前页面（选区 / 元素列表 / iframe / 页面版本号）。
 *
 * ★ 与「读当前页」的两条区别：
 *   ① 采的是**结构**（元素引用 + 状态 + 选区 + 版本号），不是整页正文；
 *   ② 走 `page:observe` 这个 kind（主进程那边渲染成 markdown 再落会话）。
 *
 * @param {{ ref?: string, sessionId?: string }} [opts] `ref` 只有 `getElements` 那条走时才传（M04-1）；
 *   `sessionId` = 侧边栏选中的那条 —— 不带的话观察结果会落进主窗口当前打开的那条
 *   （2026-10-20 修的串线，与 `ext:page` 同一处根因）。
 * @returns {Promise<object>} 给侧边栏的**人话**结果（失败也在 `error` 里写好）
 */
async function observeSessionPage(opts = {}) {
  /* 页面结构也可能含用户内容，关掉上下文后所有采集入口都要停。 */
  const ctx = await contextAllowed()
  if (!ctx.allowed) return { ok: false, error: ctx.error }
  const target = await resolveActiveTab()
  if (!target.ok) return { ok: false, error: target.error }
  const { tab } = target
  const sessionId = String(opts?.sessionId ?? '')

  /* 站点黑名单：采集之前问主进程（判定只有 ext-sites.cjs 一处） */
  const policy = await checkSite(String(target.url ?? ''))
  if (!policy.allowed) return { ok: false, error: policy.error }

  let results
  try {
    const settled = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: waitForStablePage })
    if (String(settled?.[0]?.result?.url || '') !== String(target.url || '') || !(await stillActiveTab(tab.id, target.url))) {
      return { ok: false, error: '等待页面加载时活动标签已改变；没有发送旧页面内容' }
    }
    /*
     * `func: collectPageContext` —— Chrome 会把它 **toString() 序列化**后注入页面。
     * 所以它必须自包含（不能引用模块级东西）：规矩写在 `lib/observe.js` 文件头，
     * 真机判据 ⑥ 钉着它。
     */
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageContext,
      args: [{ maxItems: 60, maxSelection: 4000 }],
    })
  } catch (error) {
    return { ok: false, error: `观察不到这个页面：${(error && error.message) || error}` }
  }

  const observation = results && results[0] && results[0].result
  if (!observation || typeof observation !== 'object') {
    return { ok: false, error: '页面没有返回观察结果（可能是受限页面）' }
  }
  if (String(observation.url || '') !== String(target.url || '') || !(await stillActiveTab(tab.id, target.url))) {
    return { ok: false, error: '观察期间页面或活动标签已改变；没有发送旧页面内容，请在当前页重试' }
  }

  /*
   * ★ M04-1：`browser.getElements` 复用**同一份采集**（同一个注入函数、同一套版本号
   *   算法、同一套 ref 登记），只是把 kind 换成 `page:elements` —— 主进程那边渲染成
   *   「只要元素」的视图，并按 ref 解析失效（判据只有那一处，硬约束 #9）。
   *   所以这里**不新写第二个采集器**（那必然漂）。
   *
   * ⚠️⚠️ 别把「发给 host 的 **type**」和「host 转给主进程的 **kind**」混了：
   *   · type = `get-elements` / `observe-page`（**扩展 ↔ host** 的名字，host 的
   *     dispatcher 按它分支）
   *   · kind = `page:elements` / `page:observe`（**host ↔ 主进程** 的名字，在
   *     `ext-protocol.cjs` 里定义）
   *   第一版这里把 kind 当 type 发了 → host 认不出 → 落兜底（回一条**没有 id** 的
   *   `{error}`）→ 扩展按 id 匹配 pending 永远配不上 → **每次都超时**
   *   （而 host / 管道 / 主进程全都正常，最容易被误判成「桥坏了」）。
   */
  const ref = String(opts?.ref ?? '')
  const elementsOnly = opts?.elementsOnly === true
  /*
   * ★ 2026-10-21：**面板上那个「观察页面」按钮**不再把结果落进会话，
   *   改送 `page-context`（写上下文槽 → 每轮注入提示词）。
   *   `getElements`（工具要 ref）仍走 `page:elements`：那是**工具调用**，
   *   模型需要回执里的 ref / stale 字段，不能塞进提示词槽。
   *
   *   观察结果由**主进程**渲染成 markdown（`renderObservation`，唯一一处实现）——
   *   所以这里只把 `observation` 原样送上去，不在扩展侧重画一份。
   */
  const type = elementsOnly ? 'get-elements' : 'page-context'
  const payload = elementsOnly
    ? (ref ? { observation, ref, sessionId } : { observation, sessionId })
    : { observation, source: 'manual', sessionId }
  const reply = await requestHost(type, payload)
  const result = {
    ok: reply && reply.ok === true,
    error: reply && reply.ok === true ? null : (reply && reply.error) || 'Harbor 没有收下这次观察',
    url: String(observation.url || ''),
    title: String(observation.title || ''),
    pageVersion: String(observation.pageVersion || ''),
    elements: Number(observation?.stats?.elements ?? 0),
    hasSelection: Boolean(observation.selection && observation.selection.text),
    stale: reply && reply.stale === true,
    /* ★ 失效的**理由**（`page-changed` / `not-found`）—— 主进程算的，这里只透传 */
    reason: String((reply && reply.reason) || ''),
    pageVersionAfter: String((reply && reply.pageVersion) || ''),
    sessionId: reply && reply.ok === true ? String(reply.sessionId ?? '') : '',
    at: Date.now(),
  }
  /* 落一份快照：面板冷启动还能看到「上次观察了什么」 */
  try {
    chrome.storage.local.set({ harborLastObserve: result })
  } catch {
    /* 存不下不影响这次结果 */
  }
  return result
}

/** 面板入口（`messages.js` 把整条消息传进来）：取出 sessionId 再走主流程。 */
export async function observePage(msg) {
  return observeSessionPage({ sessionId: String((msg && msg.sessionId) || '') })
}

/** M04-1：只要元素列表（复用同一份采集，换 kind + 带上 ref） */
export async function getElements(ref = '') {
  return observeSessionPage({ elementsOnly: true, ref: String(ref ?? '') })
}
