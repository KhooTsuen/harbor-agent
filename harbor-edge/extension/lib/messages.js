/**
 * 侧边栏消息路由（从 `service-worker.js` 拆出来的）
 *
 * ── 为什么拆 ────────────────────────────────────────────────
 *
 * SW 贴着 300 行红线，而这条 if 链是**唯一一块整块能搬走**的东西：它只做
 * 「按 type 找处理器 → 应答」，不含任何业务。搬走后 SW 只剩「装配 + 事件接线」。
 *
 * ── 两条形态（与拆之前逐字一致，别改松）──────────────────────
 *
 *   · **同步**（`get-status` / `ping`）—— 立刻 `sendResponse`，**不返回 true**
 *   · **异步**（其余）—— 返回 **`true` 保持通道**，处理完再 `sendResponse`
 *
 * ⚠️ 不认识的 type **直接 return（什么都不做）**：SW 还会收到别的消息
 *   （`harbor-push` 是单向广播，没人等应答）。改成「回一个 ok:false」会让
 *   那些广播多一次无用往返，而且可能让调用方的 promise 提前兑现。
 *
 * @param {Record<string, Function>} h 处理器表（由 SW 注入 —— 本文件不 import 业务模块，
 *   否则 SW 与它互相 import，拆了等于没拆）
 */
export function createPanelRouter(h) {
  /** 同步应答 */
  const SYNC = {
    'get-status': () => ({ state: h.getState() }),
    ping: () => {
      h.ping()
      return { ok: true, state: h.getState() }
    },
  }

  /** 异步应答：返回 Promise */
  const ASYNC = {
    'read-page': (m) => h.readActivePage(m),
    'observe-page': (m) => h.observePage(m),
    /* M04-1：只要元素列表（可带 ref —— 失效由主进程判） */
    'get-elements': (m) => h.getElements(m.ref),
    'session-list': () => h.getSessionList(),
    'chat-send': (m) => h.sendChatMessage(m.text, m.sessionId),
    'chat-resume': (m) => h.resumeChat(m.sessionId),
    'session-active': () => h.getActiveSession(),
    /* Phase 3c：选一条（只切侧边栏）/ 新建一条（两侧都切） */
    'session-select': (m) => h.selectSession(m.sessionId),
    'session-new': () => h.newSession(),
    /* M02-A2：**真正**停止这条会话正在跑的那一轮（回执来自主进程，不是本地假装） */
    'chat-abort': (m) => h.abortChat(m.sessionId),
    'chat-regenerate': (m) => h.regenerateChat(m.sessionId),
    'selection-draft': (m) => h.saveSelectionDraft(m.text, m.url),
    'site-list': () => h.listSites(),
    'site-block-temporary': (m) => h.setTemporaryBlock(m.url, m.minutes),
    'site-unblock': (m) => h.unblockSite(m.url),
  }

  return (msg, _sender, sendResponse) => {
    const type = String((msg && msg.type) || '')
    const sync = SYNC[type]
    if (sync) {
      sendResponse(sync(msg))
      return undefined
    }
    const run = ASYNC[type]
    if (!run) return undefined /* 不认识的：不接管（单向广播走这条） */
    Promise.resolve()
      .then(() => run(msg))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }))
    return true /* ★ 异步：保持通道开着等 sendResponse */
  }
}

/** 路由表里认得的消息名（自检用：保证「表里有的 SW 都注入了处理器」） */
export const PANEL_MESSAGE_TYPES = [
  'get-status',
  'ping',
  'read-page',
  'observe-page',
  'get-elements',
  'session-list',
  'chat-send',
  'chat-resume',
  'session-active',
  'session-select',
  'session-new',
  'chat-abort',
  'chat-regenerate',
  'selection-draft',
  'site-list',
  'site-block-temporary',
  'site-unblock',
]
