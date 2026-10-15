/**
 * Harbor 浏览器伴侣 · Service Worker（Phase 1c 第二步）
 *
 * 它是扩展侧**唯一**持有 native port 的地方。职责只有三件：
 *   ① 连 native host、断了就重连；
 *   ② 维护「连接状态」，广播给侧边栏；
 *   ③ 把 `action` 图标点击接到侧边栏上。
 *
 * ── 与 Phase 1b 探针版的区别（很重要）────────────────────────
 *
 * 探针版（harbor-edge/ext/service-worker.js）里有一个硬编码的
 * `REPORT_URL = http://127.0.0.1:8792/report` —— 那是**验收专用**的
 * 本地上报口。正式扩展**不会有**这种东西（用户明确要求）。
 * 探针目录原样保留，它是 Phase 1b 的验收资产，不是这里的替代品。
 *
 * ── ★ 关于「固定毫秒等待」（harbor-edge/README.md 的硬规则）──
 *
 * 本文件里的 `RECONNECT_MS` **不是就绪判据**，是「重连节奏」——
 * 判据仍然是「host 真的回了消息」（`onMessage`），不是「等了 N 毫秒就认为好了」。
 * 规矩禁的是拿固定等待当**判据**（Phase 1b / 1c 各栽过一次）。
 *
 * ── 为什么状态要落 chrome.storage ───────────────────────────
 *
 * MV3 的 SW 空闲 30 秒会被终止（Chrome 官方文档原文）。有活跃 native port
 * 时会保活（Phase 0 实测通过），但**端口没建起来时**（没装 host / Harbor 没开）
 * SW 会闲下来被杀、重连计时器一起丢。所以：
 *   · 状态写进 storage —— 侧边栏打开时能立刻显示上次的样子；
 *   · SW 每次被唤醒都重新 connect（见文件末尾）。
 */

/* global chrome */

const HOST = 'com.harbor.agent'

/** 重连节奏（不是就绪判据；见文件头） */
const RECONNECT_MS = 3000

let port = null
let timer = null
let state = { connected: false, lastError: null, lastPongAt: 0, host: HOST }

/** 状态变了：落 storage（给侧边栏冷启动读）+ 广播（给开着的侧边栏） */
function publish(patch) {
  state = { ...state, ...patch }
  try {
    chrome.storage.local.set({ harborState: state })
  } catch {
    /* storage 写不进去不该影响连接本身 */
  }
  try {
    /* 侧边栏可能没开着 —— 没有接收者时 Promise 会 reject，忽略即可 */
    const p = chrome.runtime.sendMessage({ type: 'status', state })
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* 同上 */
  }
}

function scheduleReconnect() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    connect()
  }, RECONNECT_MS)
}

function ping() {
  if (!port) return
  try {
    port.postMessage({ ping: 1, at: Date.now() })
  } catch (error) {
    publish({ connected: false, lastError: String((error && error.message) || error) })
  }
}

function connect() {
  if (port) return
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (error) {
    publish({ connected: false, lastError: String((error && error.message) || error) })
    scheduleReconnect()
    return
  }

  port.onMessage.addListener((msg) => {
    /* ★ 判据在这里：host **真的回了消息**才算连上 */
    publish({ connected: true, lastError: null, lastPongAt: Date.now(), lastReply: msg })
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    port = null
    publish({ connected: false, lastError: err ? err.message : 'host disconnected' })
    scheduleReconnect()
  })

  ping()
}

/** 点图标打开侧边栏（MV3 的 sidePanel 需要显式打开这个行为） */
function bindActionToPanel() {
  try {
    const p = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* 不支持就只是「点图标不开面板」，连不上都不算 */
  }
}

/* 侧边栏来问状态 / 来要一次 ping */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-status') {
    sendResponse({ state })
    return
  }
  if (msg && msg.type === 'ping') {
    ping()
    sendResponse({ ok: true, state })
  }
})

chrome.runtime.onInstalled.addListener(() => {
  bindActionToPanel()
  connect()
})
chrome.runtime.onStartup.addListener(connect)

bindActionToPanel()
connect()
