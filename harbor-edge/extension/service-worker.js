/**
 * Harbor 浏览器伴侣 · Service Worker（Phase 2：读当前页）
 *
 * 它是扩展侧**唯一**持有 native port 的地方。职责四件：
 *   ① 连 native host、断了就重连；
 *   ② 维护「连接状态」，广播给侧边栏；
 *   ③ 把 `action` 图标点击接到侧边栏上；
 *   ④ **Phase 2**：读当前活动标签的正文，经 native port 转给 Harbor。
 *
 * ── ★ 只读「当前活动标签」，且只在用户点击时触发 ──────────────
 *
 * 两条硬规矩（用户定的边界）：
 *   · `chrome.tabs.query({active:true, currentWindow:true})` —— 只可能拿到**前台
 *     当前标签**，不遍历、不管后台标签；
 *   · 读页面这件事**只能由侧边栏按钮发起**（消息 `read-page`），
 *     没有任何定时器 / 监听器会自己去读页面。
 *
 * ── activeTab 的授予时机（浏览器行为，不是实现选择）──────────
 *
 * `activeTab` 在**用户 invoke 扩展**时授予当前标签（点工具栏图标 / 快捷键 /
 * 右键菜单）。**点侧边栏里的按钮不算 invoke** —— 所以正常流程是：
 * 点图标开侧边栏（= invoke，此刻该标签已授权）→ 再点「读当前页」。
 * 用户换了标签之后，那个新标签**没有** activeTab（除非再点一次图标）——
 * 这时读会失败，我们把它转成一句人话提示（不是静默失败）。
 *
 * ── 为什么状态要落 chrome.storage ───────────────────────────
 *
 * MV3 的 SW 空闲 30 秒会被终止（Chrome 官方文档原文）。有活跃 native port
 * 时会保活（Phase 0 实测通过），但端口没建起来时（没装 host / Harbor 没开）
 * SW 会闲下来被杀、读取结果也会丢。所以状态与**最近一次读取结果**都写 storage。
 */

/* global chrome */

const HOST = 'com.harbor.agent'

/** 重连节奏（不是就绪判据；见 harbor-edge/README.md 的硬规则） */
const RECONNECT_MS = 3000

/**
 * 正文上限 512 KB。
 *
 * 为什么必须有：native messaging 单条消息 host→Edge 官方上限 1 MB，
 * 而页面正文可能是几十 MB（长文档 / 表格页）。这里先截断，再交给 host ——
 * host 侧还有一道 2 MB 的兜底（见 core/ext-forward.cjs）。
 */
const MAX_TEXT = 512 * 1024

/**
 * 读不了的页面（浏览器内部页）。
 *
 * 这些页面上 `executeScript` 本来就会被浏览器拒绝，但**显式判**有两个好处：
 * 错误信息是人话（而不是 "Cannot access contents of the page"），
 * 且规则**看得见**（用户能知道「哪些页面读不了」）。
 */
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

/** 点图标打开侧边栏（MV3 的 sidePanel 需要显式打开这个行为） */
function bindActionToPanel() {
  try {
    const p = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* 不支持就只是「点图标不开面板」，连不上都不算 */
  }
}

/* ══════════════════════════════════════════════════════════════
   Phase 2：读当前页
   ══════════════════════════════════════════════════════════════ */

/**
 * 把读到的内容交给 host，并等 host 的回帧。
 *
 * ⚠️ 回帧说明的是**「host 把字节写进管道了没有」**，不是「Harbor 处理成功了没有」——
 *   host 是单向写（`fs.writeFileSync`），读不到主进程的回复（探针实测，
 *   见 electron/core/ext-forward.cjs 的文件头）。所以界面文案按这个口径写。
 *   仍然要等回帧的原因是：至少要区分「发出去了」和「Harbor 没开 / 没装通道」——
 *   后者 host 会回一条人话错误（ENOENT），这正是用户最需要看到的那种失败。
 */
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
    /*
     * url 为空 = activeTab 没授予（浏览器此时不告诉你地址）。
     * 正常流程（点图标开侧边栏）不会走到这里；换过标签就会。
     */
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
  bindActionToPanel()
  connect()
})
chrome.runtime.onStartup.addListener(connect)

bindActionToPanel()
connect()
