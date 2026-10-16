/**
 * 侧边栏的**流快照 + 旁听**（2026-10-16 从 `ext-chat.cjs` 拆出）
 *
 * ── 为什么拆 ────────────────────────────────────────────────
 *
 * `ext-chat.cjs` 已 298 行贴着红线，而 M02 还要给它加 `handleAbort`。这一块
 * （快照 Map + 旁听事件 + 推分片）**自成一体**：只管「一轮跑的时候，侧边栏
 * 那边该看到什么」，与「发消息 / 选会话」那几条业务没有耦合。
 *
 * ── 快照为什么是必需的（不是优化）────────────────────────────
 *
 * 侧边栏可能**中途才打开**（面板关了、SW 被回收）。那时前面的分片早就推完了，
 * 没人接。所以留一份**全文**快照：它一问（`chat-resume`）就拿到「跑到哪了」。
 * 补发历史分片要留着所有分片 + 处理竞态；快照一次给全文，天然没这个洞。
 *
 * ★ `done` 那片推的是**全文**（不是空 text）：分片可能丢（广播没人听、
 *   面板刚打开），最后一片拿全文覆盖，两边最终一致。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

/** `done` 之后快照留多久（给「刚跑完就重连」留窗口） */
const KEEP_AFTER_DONE_MS = 60_000

/** 结构性事件推到侧边栏：让「正在跑」这类状态也看得见（content/reasoning 是增量） */
const PUSH_TYPES = new Set(['content', 'reasoning', 'done', 'aborted', 'error', 'tool_start', 'tool_end'])

/**
 * @param {{
 *   sessionIdOfRequest: (requestId: string) => string,
 *   push: (kind: string, payload: object) => void,
 *   log?: { warn?: (m: string) => void, info?: (m: string) => void },
 * }} deps
 *   `sessionIdOfRequest` 由 `ext-chat.cjs` 注入（它扫 `streams` 的 sessionId 字段 ——
 *   `chat:event` 的 payload 里没有它，那是给 `streams.set` 补该字段的用处）。
 */
function createStreamStore(deps) {
  const push = deps.push
  const log = deps.log

  /** @type {Map<string, { sessionId: string, seq: number, text: string, reasoning: string, done: boolean, at: number }>} */
  const snapshots = new Map()
  /** 只报一次「旁听到某一轮」（诊断用；不记每条 content，否则日志会被刷爆） */
  const seen = new Set()

  /** 推一份分片给扩展（推的是**增量**，不含全文） */
  function pushDelta(requestId, sessionId, seq, type, text, done) {
    push('chat:event', { requestId, sessionId, seq, type, text, done })
  }

  /**
   * 旁听一轮里的事件 —— 由 `register-handlers.cjs` 包过的 `send` 出口调，
   * 也就是渲染层**收到的同一批**（content/reasoning 已过 50ms 合批）。
   * ★ 只读旁听：不改流向、不改形状。
   */
  function onChatEvent(event) {
    const requestId = String(event?.requestId ?? '')
    if (!requestId) {
      /* 这条 warn 很重要：没有 requestId 就认不出是哪一轮，整条流都会丢 */
      log?.warn?.(`扩展通道：旁听收到一条没有 requestId 的 chat:event（type=${String(event?.type ?? '')}）`)
      return
    }
    const sessionId = String(deps.sessionIdOfRequest(requestId) ?? '')
    const type = String(event?.type ?? '')
    if (!seen.has(requestId)) {
      seen.add(requestId)
      log?.info?.(`扩展通道：旁听这一轮（${requestId} → 会话 ${sessionId || '(空)'}，首个事件 ${type}）`)
    }

    let snap = snapshots.get(requestId)
    if (!snap) {
      snap = { sessionId, seq: 0, text: '', reasoning: '', done: false, at: 0 }
      snapshots.set(requestId, snap)
    }
    snap.at = Date.now()
    /* done 带完整正文 —— 用它兜底（分段快照可能因为合批还没到齐） */
    if (type === 'done') {
      snap.text = String(event.content ?? snap.text)
      snap.reasoning = String(event.reasoning ?? snap.reasoning)
      snap.done = true
    } else if (type === 'aborted' || type === 'error') {
      snap.done = true
    } else if (type === 'content' && typeof event.text === 'string') {
      snap.text += event.text
    } else if (type === 'reasoning' && typeof event.text === 'string') {
      snap.reasoning += event.text
    }

    if (!PUSH_TYPES.has(type)) return
    snap.seq += 1
    pushDelta(requestId, snap.sessionId, snap.seq, type, type === 'done' ? snap.text : (event.text ?? ''), snap.done)

    if (snap.done) {
      /* 延迟清：立刻清的话，「刚跑完就重连」会问不到（用户看到空内容） */
      const rid = requestId
      const timer = setTimeout(() => snapshots.delete(rid), KEEP_AFTER_DONE_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  /**
   * 这条会话最近一份快照（`chat-resume` 用）。
   * ★ 同一会话可能有多条（连发两条）—— 取 `at` 最大的那条。
   */
  function latestOf(sessionId) {
    const want = String(sessionId ?? '')
    if (!want) return null
    let best = null
    for (const snap of snapshots.values()) {
      if (snap.sessionId !== want) continue
      if (!best || snap.at > best.at) best = snap
    }
    return best
  }

  /** 清掉某一轮的快照（停止之后那条不必再留着） */
  function drop(requestId) {
    snapshots.delete(String(requestId ?? ''))
  }

  return {
    onChatEvent,
    latestOf,
    drop,
    /** 自检用 */
    snapshotOf(requestId) {
      return snapshots.get(String(requestId ?? '')) ?? null
    },
  }
}

module.exports = { createStreamStore, KEEP_AFTER_DONE_MS, PUSH_TYPES }
