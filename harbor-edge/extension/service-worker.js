/**
 * Harbor 浏览器伴侣 · Service Worker（Phase 3a）
 *
 * SW 管四件事：① action / 面板 / 消息接线；② 读当前标签正文；③ 取会话列表；
 * ④ **主进程下发的指令**（M04：点 / 验）。**通道层在 `lib/native.js`。**
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

import { connect, getState, ping, requestHost, setCommandHandler } from './lib/native.js'
import { resolveActiveTab } from './lib/active-tab.js'
/* M03：观察页面（拆到单独文件，SW 贴 300 红线）· M04：指令执行 */
import { observePage, getElements } from './lib/observe-run.js'
import { runCommand } from './lib/command-run.js'

/* 正文上限 512 KB：native messaging 单条 host→Edge 官方上限 1 MB，而页面正文
   可能是几十 MB。这里先截断，host 侧还有 2 MB 兜底（core/ext-protocol.cjs）。 */
const MAX_TEXT = 512 * 1024

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
  /* 「拿前台标签 + 判受限页」共用一处（M03 与 observe 一起用；文案不许改，见 lib/active-tab.js） */
  const target = await resolveActiveTab()
  if (!target.ok) return { ok: false, error: target.error }
  const { tab, url } = target

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

/* ══════════════════════════════════════════════════════════════
   发消息 / 续流（Phase 3b）
   ══════════════════════════════════════════════════════════════ */

/**
 * 侧边栏发一条消息。`sessionId` = 侧边栏**自己**选中的那条（可能是空）。
 * ★ SW 只做转发：谁允许发 / 忙不忙 / 落到哪条，全由主进程判（ext-chat.cjs）。
 */
async function sendChatMessage(text, sessionId = '') {
  const reply = await requestHost('chat:send', {
    text: String(text ?? ''),
    sessionId: String(sessionId ?? ''),
  })
  if (reply && reply.ok === true) {
    const info = { sessionId: String(reply.sessionId ?? ''), at: Date.now() }
    try {
      chrome.storage.local.set({ harborChat: info })
    } catch {
      /* 存不下不影响这次发送 */
    }
    return { ok: true, ...info }
  }
  return { ok: false, error: (reply && reply.error) || '发不出去', code: (reply && reply.code) || '' }
}

/**
 * 重连 / 重开后要「上次流到哪」。
 *
 * ★ 按 **sessionId** 问（不是 requestId）：真实那一轮的 id 是渲染层生成的，
 *   扩展侧从没听过它 —— 它只知道「我在看哪条会话」（见 ext-chat.cjs 的 handleResume）。
 */
async function resumeChat(sessionId) {
  const reply = await requestHost('chat:resume', { sessionId: String(sessionId ?? '') })
  return reply && typeof reply === 'object' ? reply : { ok: false, error: '拿不到流快照' }
}

/**
 * 问「Harbor 界面当前打开的是哪条会话」。
 *
 * 为什么要问：侧边栏要发的那条消息，落点由**主进程认定的当前会话**决定
 * （`handler ext:activeSession` 报的）—— 扩展侧不该自己猜一条。
 */
async function getActiveSession() {
  const reply = await requestHost('ext:sessionActive', {})
  if (reply && reply.ok === true) return { ok: true, sessionId: String(reply.sessionId ?? '') }
  return { ok: false, sessionId: '', error: (reply && reply.error) || '拿不到当前对话' }
}

/**
 * Phase 3c：侧边栏**选**一条会话。
 *
 * ⚠️ 只改「侧边栏在看哪条」，**主窗口不动**（用户 2026-10-16 拍板）——
 *    所以这里不碰 Harbor 的 activeSession，真相在主进程那套 selectedSessionId。
 */
async function selectSession(sessionId) {
  const reply = await requestHost('session:select', { sessionId: String(sessionId ?? '') })
  return reply && typeof reply === 'object' ? reply : { ok: false, error: '切会话失败' }
}

/** Phase 3c：侧边栏顶栏那个 ＋ —— 新建一条（渲染层会切过去，两侧同步） */
async function newSession() {
  const reply = await requestHost('session:new', {})
  return reply && typeof reply === 'object' ? reply : { ok: false, error: '新建会话失败' }
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
  if (msg && msg.type === 'observe-page') {
    observePage()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  /* M04-1：只要元素列表（可带 ref —— 失效由主进程判） */
  if (msg && msg.type === 'get-elements') {
    getElements(msg.ref)
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
  if (msg && msg.type === 'chat-send') {
    sendChatMessage(msg.text, msg.sessionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  if (msg && msg.type === 'chat-resume') {
    resumeChat(msg.sessionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  if (msg && msg.type === 'session-active') {
    getActiveSession()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  /* Phase 3c：选一条（只切侧边栏）/ 新建一条（两侧都切） */
  if (msg && msg.type === 'session-select') {
    selectSession(msg.sessionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
  if (msg && msg.type === 'session-new') {
    newSession()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true
  }
})

chrome.runtime.onInstalled.addListener(() => {
  bindAction()
  bindCommandHandler()
  connect()
})
chrome.runtime.onStartup.addListener(connect)

/**
 * M04：把「主进程下发指令」这条线接上（见 `lib/command-run.js`）。
 *
 * ★ 少了这一句的表现：主进程 `call('click')` 推出去的指令**没人接** ——
 *   扩展既不点、也不回执 → 主进程 15 秒后超时 → 用户看到「浏览器没在 15 秒内回话」，
 *   而**浏览器好端端的**。所以自检组有一条钉着这个注册。
 */
function bindCommandHandler() {
  setCommandHandler(runCommand)
}

bindAction()
bindCommandHandler()
connect()
