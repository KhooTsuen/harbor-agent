/**
 * Harbor 浏览器伴侣 · Service Worker（Phase 2：读当前页）
 *
 * 扩展侧**唯一**持有 native port 的地方。职责四件：① 连 native host、断了就重连；
 * ② 维护连接状态并广播给侧边栏；③ 点图标开侧边栏（这一下同时授予 activeTab）；
 * ④ 读当前活动标签的正文，经 native port 转给 Harbor。
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
 * MV3 的 SW 空闲 30 秒会被终止；有活跃 native port 时保活（Phase 0 实测），端口没建起来
 * 时会被杀 —— 所以状态与最近一次读取结果都落 chrome.storage。
 */

/* global chrome */

const HOST = 'com.harbor.agent'

/** 重连节奏（不是就绪判据；见 harbor-edge/README.md 的硬规则） */
const RECONNECT_MS = 3000

/* 正文上限 512 KB：native messaging 单条 host→Edge 官方上限 1 MB，而页面正文
   可能是几十 MB。这里先截断，host 侧还有 2 MB 兜底（core/ext-forward.cjs）。 */
const MAX_TEXT = 512 * 1024

/* 读不了的页面（浏览器内部页）：显式判为了给人话错误，且让「哪些读不了」看得见。 */
const BLOCKED_PROTOCOL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|chrome-untrusted):/i

let port = null
let timer = null
let state = { connected: false, lastError: null, lastPongAt: 0, host: HOST }
/** 正在等 host 回包的那次读取（同时只允许一次） */
let pendingRead = null

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
    /* Phase 2：读页面的回包（host 把主进程的处理结果带回来了） */
    if (msg && msg.type === 'ext:page.result' && pendingRead) {
      const done = pendingRead
      pendingRead = null
      done(msg)
    }
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    port = null
    publish({ connected: false, lastError: err ? err.message : 'host disconnected' })
    /* 连接断了，正在等的那次读取不能永远挂着 */
    if (pendingRead) {
      const done = pendingRead
      pendingRead = null
      done({ ok: false, error: '与 Harbor 的连接断开了' })
    }
    scheduleReconnect()
  })

  ping()
}

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
   Phase 2：读当前页
   ══════════════════════════════════════════════════════════════ */

/* 把读到的内容交给 host，并等 host 的回帧。⚠️ 回帧只说明「host 把字节写进管道了」，
   不是「Harbor 处理成功了」—— host 是单向写，读不到主进程回复（见 ext-forward.cjs）。
   仍要等回帧是为了区分「发出去了」和「Harbor 没开 / 没装通道」（后者 host 回人话错误）。 */
function sendPageToHost(payload) {
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, error: '没连上 Harbor（先在下面点「重试」）' })
      return
    }
    /* 同时只允许一次读取 —— 免得两次点击的回包互相错配 */
    if (pendingRead) {
      resolve({ ok: false, error: '上一次读取还没回来' })
      return
    }
    const timerId = setTimeout(() => {
      pendingRead = null
      resolve({ ok: false, error: 'Harbor 没有响应（超时）' })
    }, 15000)
    pendingRead = (msg) => {
      clearTimeout(timerId)
      resolve(msg && typeof msg === 'object' ? msg : { ok: false, error: '回了看不懂的东西' })
    }
    try {
      port.postMessage(payload)
    } catch (error) {
      clearTimeout(timerId)
      pendingRead = null
      resolve({ ok: false, error: String((error && error.message) || error) })
    }
  })
}

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

  const reply = await sendPageToHost({
    type: 'ext:page',
    url,
    title,
    text,
    truncated,
    id: `r${Date.now().toString(36)}`,
  })

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

/* ── 侧边栏来的消息 ────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-status') {
    sendResponse({ state })
    return
  }
  if (msg && msg.type === 'ping') {
    ping()
    sendResponse({ ok: true, state })
    return
  }
  if (msg && msg.type === 'read-page') {
    /* 异步：返回 true 保持通道，处理完再 sendResponse */
    readActivePage()
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
