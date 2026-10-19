/**
 * Codex MCP 桥的**对话上下文登记表**（2026-10-17 阶段三 · 真实审批）
 *
 * ── 它解决什么问题 ────────────────────────────────────────────
 *
 * 审批卡必须落在**发起这次操作的那条对话**上（用户第 2 条）。可桥是主进程里
 * 一个**常驻**的东西，它不属于任何一轮对话；而 Harbor 的 `chatConfirm.askUser`
 * 需要 `requestId` + `emit`（渲染层按 `requestId` 过滤事件，见 `chat-emit.cjs`）。
 *
 * 所以：`chat:send` 在开跑时把「这一轮的上下文」按 `runId` 登记进来，
 * 桥拿到 codex 传来的 `runId` 后**按它取回那一轮的 confirm** —— 卡于是天然
 * 绑在正确的 requestId 上，用户切到别的会话也不会收到、也不会错配。
 *
 * ── ★ fail-closed：查不到就拒绝（不是「找个默认的顶上」）──────
 *
 * `runId` 查不到（对话已结束 / 值被伪造 / 桥被别的进程调）→ 桥**直接拒绝**该调用，
 * 绝不用「当前活跃会话」之类的东西顶替。理由与 `_shared.resolvePath` 同源：
 * 猜一个上下文等于把审批发给一个**没请求过这件事**的人。
 *
 * ── 为什么单列一个模块 ────────────────────────────────────────
 *
 * 登记方（`handlers/chat.cjs`）与使用方（`codex-mcp-bridge.cjs`）是两个方向，
 * 既不能互相 require（会成环），也不该各自存一份（那就是两份真相源）。
 * 它不 require electron，纯 Map —— 自检能在纯 Node 里直接跑。
 */

/** runId → { requestId, sessionId, confirm, source, at } */
const entries = new Map()

/**
 * 登记过期时间。一轮对话最长可能跑很久，所以给得宽；
 * 它的作用只是**兜底防泄漏**（正常路径由 `unregister` 清）。
 */
const TTL_MS = 60 * 60 * 1000

/**
 * runId 的形状。★ 它会经 `-c` 拼进 codex 的命令行（见 `codex-mcp-lifecycle.cjs`），
 * 所以**只允许**字符集安全的写法 —— 别的形状一律不登记（宁可不启用）。
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,120}$/

/**
 * 登记一轮对话的上下文。
 *
 * @param {string} runId 这一轮的标识（= `chat:send` 的 `phaseKey`，也是 codex 的 `traceId`）
 * @param {{ requestId?: string, sessionId?: string, confirm?: Function, source?: string,
 * collab?: boolean, workdir?: string, permission?: string, threadSettings?: object,
 * allowWrite?: boolean, allowNetwork?: boolean, vision?: object, signal?: AbortSignal }} ctx
 * @returns {boolean} 登记成功了吗（runId 形状不对 / 没有 confirm → false）
 */
function register(runId, ctx = {}) {
  const key = String(runId ?? '')
  if (!RUN_ID_RE.test(key)) return false
  if (typeof ctx.confirm !== 'function') return false
  entries.set(key, {
    requestId: String(ctx.requestId ?? ''),
    sessionId: String(ctx.sessionId ?? ''),
    collab: ctx.collab === true,
    workdir: String(ctx.workdir ?? ''),
    permission: String(ctx.permission ?? 'ask'),
    threadSettings: { ...ctx.threadSettings },
    allowWrite: ctx.allowWrite !== false,
    allowNetwork: ctx.allowNetwork !== false,
    vision: ctx.vision ?? null,
    signal: ctx.signal,
    confirm: ctx.confirm,
    /* 卡的来源标注（现在是 'codex'，将来别的通道接进来能复用这张表） */
    source: String(ctx.source ?? 'codex'),
    at: Date.now(),
  })
  return true
}

/**
 * 取回上下文（**过期的一律当没有**）。
 *
 * @param {string} runId
 * @returns {{ requestId: string, sessionId: string, confirm: Function, source: string, at: number,
 * collab: boolean, workdir: string, permission: string, threadSettings: object,
 * allowWrite: boolean, allowNetwork: boolean, vision: object|null, signal?: AbortSignal } | null}
 */
function get(runId) {
  const key = String(runId ?? '')
  const hit = entries.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TTL_MS) {
    entries.delete(key)
    return null
  }
  return hit
}

/** 这一轮结束了 → 注销（桥之后拿它做的任何审批请求都会被拒） */
function unregister(runId) {
  return entries.delete(String(runId ?? ''))
}

/**
 * 按**对话 requestId** 注销（`chat:abort` 走这条 —— 那里只拿得到 requestId，
 * 而登记的 key 是 `phaseKey`，两者可能不同）。
 *
 * @returns {number} 删掉了几条
 */
function unregisterByRequest(requestId) {
  const want = String(requestId ?? '')
  if (!want) return 0
  let n = 0
  for (const [key, value] of entries) {
    if (value.requestId === want) {
      entries.delete(key)
      n += 1
    }
  }
  return n
}

/** 现在登记着几条（自检 / 诊断用） */
function size() {
  return entries.size
}

module.exports = { register, get, unregister, unregisterByRequest, size, RUN_ID_RE, TTL_MS }
