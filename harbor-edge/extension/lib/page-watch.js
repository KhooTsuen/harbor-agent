/**
 * 切页面时**自动**把当前页正文送进「页面上下文槽」（2026-10-21）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 *
 * 用户原话：「做成实时信息传输，并且不要占用对话流，相当于提示词那一类的植入进去」。
 * 以前只有「点一下按钮才传一次」——换页面就过期，而且那一传会往对话流里塞一段网页正文
 * （实测连点 30 次就把会话撑住了）。
 *
 * 现在：**切标签 / 页面加载完就自动更新那个槽**（`core/page-context-slot.cjs`），
 * 主进程每轮构建提示词时注入一节「用户当前正在看的网页」。对话流里一条都不多。
 *
 * ── 五条闸门（少一条都会出事）────────────────────────────────
 *
 * ① **上下文开关**：用户在网页卡上关掉「带上」→ 自动采集一律停（`context-gate.js`，
 *    与读当前页 / 观察页面共用同一道门，不另写一套判据）。
 * ② **站点黑名单**：拉黑过的站点不读（`site-policy.js` → 主进程 `ext-sites.cjs`）。
 * ③ **协议**：`edge://` / `about:` 这类内部页跳过（判据在 `active-tab.js` 的 `BLOCKED_PROTOCOL`）。
 * ④ **权限**：自动触发时**没有 activeTab**（那不是用户手势）。所以只有用户开了「整站读取」
 *    才读得到 —— 没权限时 `executeScript` 会抛，这里**静默跳过**，不弹错、不打扰。
 * ⑤ **节流**：同一个标签 + 同一个 URL 在 `THROTTLE_MS` 内不重复读（切回来切回去
 *    不该反复注入脚本）。
 *
 * ⚠️ 只读**前台活动标签**，与 `resolveActiveTab` 的口径一致 —— 后台标签一律不碰。
 * ⚠️ `collectPageText` 必须自包含（见 `page-text.js` 文件头），这里只调用不重写。
 */

/* global chrome */

import { requestHost } from './native.js'
import { collectPageText, limitPageText } from './page-text.js'
import { contextAllowed } from './context-gate.js'
import { checkSite } from './site-policy.js'
import { BLOCKED_PROTOCOL } from './active-tab.js'

/** 同一 tab + 同一 url 的重读间隔（来回切标签不该反复注入） */
const THROTTLE_MS = 10000

/** 与 service-worker.js 的 MAX_TEXT 同一个口径（native message 单帧上限） */
const MAX_TEXT = 512 * 1024

/** 最近一次成功上报的指纹（只用来节流，不落盘） */
let last = { key: '', at: 0 }
/** 串行化：切标签可能连发两三个事件，别让它们同时注入 */
let running = false

/**
 * 读一个标签并上报。**所有失败都静默**（自动行为不该弹错误打扰用户）。
 *
 * @param {number} tabId
 * @param {{ url?: string, title?: string }} [hint] 事件里带来的信息（省一次 query）
 */
async function pushTab(tabId, hint = {}) {
  if (running) return
  running = true
  try {
    const ctx = await contextAllowed()
    if (!ctx.allowed) return

    const list = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = list && list[0]
    if (!tab || tab.id !== tabId) return
    const url = String(tab.url || hint.url || '')
    /* 拿不到 url = 没有该站权限（自动触发时没有 activeTab）→ 静默跳过 */
    if (!url || BLOCKED_PROTOCOL.test(url)) return

    const key = `${tabId}|${url}`
    const now = Date.now()
    if (last.key === key && now - last.at < THROTTLE_MS) return

    const policy = await checkSite(url)
    if (!policy.allowed) return

    let results
    try {
      results = await chrome.scripting.executeScript({ target: { tabId }, func: collectPageText })
    } catch {
      /* 没权限 / 页面正在加载 —— 跳过这次，用户还能手点「读当前页」 */
      return
    }
    const first = results && results[0] && results[0].result
    if (!first || String(first.url || '') !== url) return

    const page = limitPageText(first, MAX_TEXT)
    const reply = await requestHost('page-context', {
      url,
      title: page.title || String(tab.title || ''),
      text: page.text,
      truncated: page.truncated === true,
      source: 'auto',
      /*
       * 自动上报落**全局槽**（`scope:'global'`，2026-10-21）：
       * 「你在浏览器里正在看这个页面」与哪条会话无关 —— 主窗口开哪条都该看得到。
       * ⚠️ 别只传空 sessionId 了事：主进程会退回「侧边栏选中的那条」，
       *    于是变成只有那一条会话看得到（实测会话 A 能、会话 B 不能）。
       */
      sessionId: '',
      scope: 'global',
    })
    if (reply && reply.ok === true) last = { key, at: now }
  } catch {
    /* 自动行为：任何异常都咽掉，不影响用户 */
  } finally {
    running = false
  }
}

/** 装上两个监听（SW 启动时调一次）。**必须幂等** —— SW 会被反复唤醒。 */
let bound = false
export function bindPageWatch() {
  if (bound) return
  bound = true
  try {
    /* 切到另一个标签 */
    chrome.tabs.onActivated.addListener((info) => {
      void pushTab(info.tabId)
    })
    /* 当前标签自己刷新完了（SPA 里 status 可能一直是 complete，靠 url 节流兜住） */
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.status !== 'complete') return
      if (!tab || tab.active !== true) return
      void pushTab(tabId, { url: String(tab.url || ''), title: String(tab.title || '') })
    })
  } catch {
    /* 没有 tabs 事件（极少见）—— 手点「读当前页」仍然可用 */
  }
}

/** 给自检用：清掉节流状态 */
export function resetWatchState() {
  last = { key: '', at: 0 }
  running = false
}
