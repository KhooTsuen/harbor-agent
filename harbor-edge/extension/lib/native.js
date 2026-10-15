/**
 * 扩展侧：native port 的**通道层**（Phase 3a）
 *
 * ── 为什么从 service-worker.js 拆出来 ────────────────────────
 *
 * Phase 3a 把「单槽 pendingRead」升级成「按 id 匹配的 pending Map」（支持并发），
 * 再加上会话列表，SW 会超 300 行。拆出来的这一层是**通道职责**：连 host、断了重连、
 * 状态广播、按 id 收发。SW 只管「装上事件 + 业务处理」。
 *
 * ── ★ request/response 的匹配 ────────────────────────────────
 *
 * 扩展产生 `id`（`r<36进制>+序号`）→ host 原样带回来 → 这里按 id 兑现 Promise。
 * 一条 `id` **全链路透传**（host 不重新编号）—— 所以这个 Map 就是唯一真相。
 *
 * ⚠️ 回帧的匹配**只看 id**，不看 `type`：host 回的 type 是 `xxx.result`（与请求的
 *    type 不同名），靠 type 匹配会错位。
 *
 * ── 状态为什么落 chrome.storage ──────────────────────────────
 *
 * MV3 的 SW 空闲 30 秒会被终止；有活跃 native port 时保活，但端口没建起来时
 * （没装 host / Harbor 没开）会被杀。所以状态写 storage —— 侧边栏打开时能立刻
 * 显示上次的样子，而不用等 SW 醒。
 */

/* global chrome */

export const HOST = 'com.harbor.agent'

/** 重连节奏（**不是就绪判据**；见 harbor-edge/README.md 的硬规则） */
const RECONNECT_MS = 3000

/** 请求默认超时。**故意比 host 侧的 8s 长** —— 让 host 先超时、回一条带 code 的人话 */
const DEFAULT_TIMEOUT_MS = 15000

let port = null
let timer = null
let seq = 0
let state = { connected: false, lastError: null, lastPongAt: 0, host: HOST }

/** 在途请求：`id → { resolve, timer }`（并发安全 —— 多条可同时在途） */
const pending = new Map()

/** 当前连接状态（侧边栏 `get-status` 用） */
export function getState() {
  return state
}

export function isConnected() {
  return Boolean(port)
}

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

/** 在途请求全部结掉 —— 每条都给人话（不让侧边栏干等） */
function settleAll(reason, code) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, error: reason, code })
  }
  pending.clear()
}

export function ping() {
  if (!port) return
  try {
    port.postMessage({ ping: 1, at: Date.now() })
  } catch (error) {
    publish({ connected: false, lastError: String((error && error.message) || error) })
  }
}

export function connect() {
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
    /* 按 id 兑现（只看 id —— 见文件头：回帧的 type 与请求不同名） */
    if (msg && typeof msg.id === 'string' && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      entry.resolve(msg)
    }
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    port = null
    publish({ connected: false, lastError: err ? err.message : 'host disconnected' })
    settleAll('与 Harbor 的连接断开了', 'DISCONNECTED')
    scheduleReconnect()
  })

  ping()
}

/**
 * 发一条请求给 host，等它的回帧。
 *
 * @param {string} type 例如 `ext:page` / `ext:sessionList`
 * @param {Record<string, unknown>} [payload]
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, any>>} host 的回帧（`{ok:true,…}` 或 `{ok:false,error,code}`）
 */
export function requestHost(type, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, error: '没连上 Harbor（先在下面点「重试」）', code: 'NO_PORT' })
      return
    }
    const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`
    const entry = {
      timer: setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: 'Harbor 没有响应（超时）', code: 'TIMEOUT' })
      }, timeoutMs),
      resolve,
    }
    pending.set(id, entry)
    try {
      port.postMessage({ type, id, ...payload })
    } catch (error) {
      pending.delete(id)
      clearTimeout(entry.timer)
      resolve({ ok: false, error: String((error && error.message) || error), code: 'PORT_ERROR' })
    }
  })
}
