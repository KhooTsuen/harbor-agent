/**
 * Harbor 浏览器伴侣 · Service Worker（Phase 3a）
 *
 * SW 只管三件事：① 装上 action / 面板 / 消息的接线；② 读当前活动标签的正文；
 * ③ 取会话列表。**通道那层（连 host、重连、按 id 收发）在 `lib/native.js`。**
 *
 * ── ★ 两条硬规矩（用户定的边界）────────────────────────────
 *   · `chrome.tabs.query({active:true, currentWindow:true})` —— 只可能拿到**前台当前
 *     标签**，不遍历后台；读页面**只能由侧边栏按钮发起**（消息 `read-page`），
 *     没有任何定时器 / 监听器会自己去读页面。
 *
 * ── ★ activeTab 的授予时机（浏览器行为：实测 + 官方文档）─────
 * 官方列的只有四种：**执行操作（点扩展图标）/ 右键菜单 / 快捷键 / 多功能框**。
 * **点侧边栏里的按钮不算 invoke** —— 正确流程是：点图标（= invoke，同时打开侧边栏）
 * → 再点「读当前页」。用户换标签后新标签没有 activeTab，读会失败（转人话提示）。
 * ⚠️ `setPanelBehavior({openPanelOnActionClick:true})` **行不通**：它把图标点击接管成
 *   「切换侧边栏条目显示」，不算 action 执行，activeTab 于是从不授予（2026-10-15 真机
 *   踩到）。改法见 bindAction()：用 action.onClicked 自己开面板，这一下才是真 invoke。
 */

/* global chrome */

import { connect, getState, ping, requestHost } from './lib/native.js'

/* 正文上限 512 KB：native messaging 单条 host→Edge 官方上限 1 MB，而页面正文
   可能是几十 MB。这里先截断，host 侧还有 2 MB 兜底（core/ext-protocol.cjs）。 */
const MAX_TEXT = 512 * 1024

/* 读不了的页面（浏览器内部页）：显式判为了给人话错误，且让「哪些读不了」看得见。 */
const BLOCKED_PROTOCOL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|chrome-untrusted):/i

/* ★ 点图标 = 真正的「执行操作」（activeTab 由此授予）→ 打开侧边栏。必须走
   action.onClicked：`setPanelBehavior({openPanelOnActionClick})` 把图标点击接管成
   「切换侧边栏显示」，不算 action 执行，activeTab 于是从不授予（真机踩过，见文件头）。
   顺带把这次 invoke 记进 storage（`harborInvoke`）—— 诊断用：能看出 tab.url 可不可见。 */
function bindAction() {
  try {
    chrome.action.onClicked.addListener((tab) => {
      const info = {
        at: Date.now(),
        tabId: tab && tab.id != null ? tab.id : null,
        /* ★ 这一条就是 activeTab 的判据：true = 授予了（能看到地址） */
        hasUrl: Boolean(tab && tab.url),
        url: String((tab && tab.url) || ''),
        opened: false,
        openErr: null,
      }
      const done = (patch) => {
        Object.assign(info, patch)
        try {
          chrome.storage.local.set({ harborInvoke: info })
        } catch {
          /* 存不下不影响开面板 */
        }
      }
      try {
        const opened = chrome.sidePanel.open({ windowId: tab.windowId })
        if (opened && typeof opened.then === 'function') {
          opened
            .then(() => done({ opened: true }))
            .catch((error) => done({ openErr: String((error && error.message) || error) }))
        } else {
          done({ opened: true })
        }
      } catch (error) {
        done({ openErr: String((error && error.message) || error) })
      }
    })
  } catch {
    /* 不支持 action.onClicked 就只是「点图标不开面板」——不算致命 */
  }
}

/* ══════════════════════════════════════════════════════════════
   读当前页
   ══════════════════════════════════════════════════════════════ */

/** 读当前活动标签的标题 + 正文（只读前台那一个） */
async function readActivePage() {
  let tab
  try {
    const list = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = list && list[0]
  } catch (error) {
    return { ok: false, error: `拿不到当前标签页：${(error && error.message) || error}` }
  }
  if (!tab || tab.id == null) return { ok: false, error: '找不到当前标签页' }

  const url = String(tab.url || '')
  if (!url) {
    /* url 为空有两种原因，不能混成一句话（否则提示会**误导**用户反复点图标）：
       (a) 这个标签没被 invoke 过（换过标签）→ 提示「先点图标」，点了有用；
       (b) 这本就是**受限页面**（edge:// / about: / chrome://）—— 浏览器不给 url，
           点多少图标都没用 → 得直接说「不支持读取」。
       判据是 bindAction 留下的 harborInvoke：同一 tabId 且**当时也看不到** url → (b)。 */
    const inv = await new Promise((resolve) => {
      try {
        chrome.storage.local.get('harborInvoke', (o) => resolve(o && o.harborInvoke))
      } catch {
        resolve(null)
      }
    })
    if (inv && inv.tabId === tab.id && inv.hasUrl === false) {
      return { ok: false, error: '该页面不支持读取（浏览器内部页读不了）' }
    }
    return { ok: false, error: '读不到当前页地址 —— 先点一下工具栏的 Harbor 图标再试' }
  }
  if (BLOCKED_PROTOCOL.test(url)) {
    return { ok: false, error: '该页面不支持读取' }
  }

  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title || '',
        text: document.body ? document.body.innerText || '' : '',
      }),
    })
  } catch (error) {
    return { ok: false, error: `读不到这个页面：${(error && error.message) || error}` }
  }

  const first = results && results[0] && results[0].result
  const title = String((first && first.title) || tab.title || '')
  let text = String((first && first.text) || '')
  const truncated = text.length > MAX_TEXT
  if (truncated) text = text.slice(0, MAX_TEXT)

  const reply = await requestHost('ext:page', { url, title, text, truncated })

  const result = {
    ok: reply && reply.ok === true,
    error: reply && reply.ok === true ? null : (reply && reply.error) || 'Harbor 没有收下这条内容',
    url,
    title,
    chars: text.length,
    truncated,
    at: Date.now(),
  }
  /* 落一份快照：侧边栏冷启动时还能看到「上次读了什么」 */
  try {
    chrome.storage.local.set({ harborLastPage: result })
  } catch {
    /* 存不下不影响这次结果 */
  }
  return result
}

/* ══════════════════════════════════════════════════════════════
   会话列表（Phase 3a 新增，**只读**）
   ══════════════════════════════════════════════════════════════ */

/** 取会话列表（只读）。结果落一份快照 —— 面板打开即有内容，再异步刷新。 */
async function getSessionList() {
  const reply = await requestHost('ext:sessionList', {})
  if (reply && reply.ok === true) {
    const sessions = Array.isArray(reply.sessions) ? reply.sessions : []
    try {
      chrome.storage.local.set({ harborSessions: { sessions, at: Date.now() } })
    } catch {
      /* 存不下不影响这次结果 */
    }
    return { ok: true, sessions }
  }
  return { ok: false, error: (reply && reply.error) || '拿不到会话列表', code: (reply && reply.code) || '' }
}

/* ── 侧边栏来的消息 ────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-status') {
    sendResponse({ state: getState() })
    return
  }
  if (msg && msg.type === 'ping') {
    ping()
    sendResponse({ ok: true, state: getState() })
    return
  }
  if (msg && msg.type === 'read-page') {
    /* 异步：返回 true 保持通道，处理完再 sendResponse */
    readActivePage()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  if (msg && msg.type === 'session-list') {
    getSessionList()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
})

chrome.runtime.onInstalled.addListener(() => {
  bindAction()
  connect()
})
chrome.runtime.onStartup.addListener(connect)

bindAction()
connect()
