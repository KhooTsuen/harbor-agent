/**
 * 侧边栏发消息 / 流式回复（Phase 3b）
 *
 * ── ★ 为什么主进程**不自己跑**这一轮（C-α，用户 2026-10-16 拍板）──
 *
 * assistant 的落盘（`src/stores/thread/replyPersistence.ts`）**只在渲染层** ——
 * 主进程一个字节都不落（3b 设计说明 §1 逐条查过）。主进程若自己调 `loop.run()`，
 * 那一轮就没有 replyPersistence → 回复**不落盘**，而且落盘形状还要再造一份
 * （硬约束 #9 的同一件事写两遍）。所以这条路的定位是**校验 + 转发 + 旁听**：
 *
 *   侧边栏 chat:send
 *     → 这里校验（主窗口在不在 / 有没有当前会话 / 那条会话忙不忙）
 *     → `send('chat:event', { type:'ext:send', … })` 推给**渲染层**
 *     → 渲染层照常走它自己那条 turn（与用户手打**同一条路**）→ 既有链路落盘 ✓
 *   同时旁听每一轮的事件（`onChatEvent`）→ 更新快照 + 推给扩展（侧边栏看流式）
 *
 * ── 为什么「忙」要在**这里**拦，不能交给渲染层 ────────────────
 *
 * 渲染层 `useThreadStore.sendMessage` 遇到「这条会话在跑」是**静默排队**
 * （AG-025：`enqueueMessage` + toast「已加入队列」）。而侧边栏那边用户看不到
 * 主窗口的队列 —— 他会以为消息丢了。所以按设计说明 §6：**拒绝 + 人话**。
 *
 * ── 快照是本阶段**唯一新增的状态** ─────────────────────────────
 *
 * `Map<requestId, { sessionId, seq, text, reasoning, done, at }>`。
 * 为什么不复用 `events.cjs`：它**刻意不落流式增量**，且环形缓冲全体共享
 * （一部长回答就冲光）—— 「上次流到哪」只能靠这份内存快照（设计说明 §3.2）。
 * `done` 之后延迟 60s 清（给重连留窗口），免得 Map 无限涨。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const P = require('./ext-protocol.cjs')

/** 推给渲染层的事件名（走 `chat:event` channel，**不是新 IPC 通道**） */
const EXT_SEND = 'ext:send'

/** `done` 之后快照留多久（给「刚跑完就重连」留窗口） */
const KEEP_AFTER_DONE_MS = 60_000

/**
 * @param {{
 *   streams: Map<string, any>,
 *   getMainWindow: () => unknown,
 *   send: (channel: string, payload: object) => void,
 *   log?: { warn?: (m: string) => void, info?: (m: string) => void },
 * }} deps
 */
function createChatRelay(deps) {
  const streams = deps.streams
  const getMainWindow = deps.getMainWindow
  const send = deps.send
  const log = deps.log

  /** @type {Map<string, { sessionId: string, seq: number, text: string, reasoning: string, done: boolean, at: number }>} */
  const snapshots = new Map()
  /**
   * 管道那头的桥 —— 装配时给（`setBridge`）。
   *
   * 为什么要晚绑：bridge 需要本模块的**分派**，本模块需要 bridge 的
   * `push` 与 `getActiveSession` —— 互相依赖。所以先各自建好，再一行绑上。
   */
  let bridge = null

  /** 只报一次「旁听到某一轮」（诊断用；不记每条 content，否则日志会被刷爆） */
  const seen = new Set()

  /** 这个错误形状与 `ext-ops.handle` 一致（bridge 那边直接进 failure 帧） */
  const fail = (code, message) => ({ ok: false, error: { code, message } })

  /**
   * 这条会话上有没有**正在跑**的请求。
   *
   * ★ 判据是 `streams` 里的 `sessionId` —— **不是** `lifecycle` 的 `UNFINISHED`：
   *   `chat.cjs:54` 的 `phaseKey` 是 `payload.taskId || requestId`（**不是会话 id**），
   *   而 `lifecycle` 的注册表是 `taskId → machine`，没有「按会话查」的入口。
   *   所以按设计说明 §6 的结论：给 `streams.set` 补一个 `sessionId` 字段，扫它。
   *   **不新增状态**：`streams.delete` 已经管住「跑完了」。
   */
  function busyRequestOf(sessionId) {
    if (!sessionId) return ''
    for (const [rid, entry] of streams) {
      if (entry && entry.sessionId === sessionId) return rid
    }
    return ''
  }

  /**
   * 侧边栏请求「发一条消息」。
   *
   * @param {{ text?: string }} [payload]
   */
  function handleSend(payload) {
    const text = String(payload?.text ?? '').trim()
    if (!text) return fail(P.ERR.INTERNAL, '消息是空的')

    /*
     * C-α：执行者是渲染层 —— 它不在，这一轮根本跑不起来，所以**早拒**，
     * 回人话而不是让它挂着（设计说明 §1 已写明这是有意的取舍）。
     * ★ 默认配置下关窗口 = hideToTray（main.cjs:135），窗口没销毁，这一条不会命中。
     */
    if (!getMainWindow || !getMainWindow()) {
      return fail(P.ERR.NO_WINDOW, 'Harbor 主窗口不在（先打开 Harbor 再发）')
    }

    const sessionId = String(bridge?.getActiveSession?.() ?? '')
    if (!sessionId) return fail(P.ERR.NO_SESSION, 'Harbor 里没有打开的对话（先打开一条）')

    if (busyRequestOf(sessionId)) {
      return fail(P.ERR.SESSION_BUSY, '这条对话正在别处运行（等它跑完，或先停止）')
    }

    /*
     * 推给渲染层 —— 它接住后照常走 runElectronTurn（与用户手打**同一条路**）。
     *
     * ★ **不给它 requestId**：真实的那一轮由渲染层自己生成 id（`turns.ts`），
     *   这里若编一个假的，侧边栏拿它去 `chat:resume` 会查不到（两个 id 不是一回事）。
     *   所以「哪一轮」一律按 **`sessionId`** 认（见 handleResume）。
     */
    send('chat:event', { type: EXT_SEND, sessionId, text })
    log?.info?.(`扩展通道：侧边栏发来一条消息 → 交给渲染层跑（会话 ${sessionId}）`)
    return { ok: true, sessionId }
  }

  /**
   * 侧边栏重连 / 重开后要「上次流到哪」。
   *
   * 回**一份快照**而不是补发历史分片：补发要把所有分片都留着（内存 × 条数），
   * 还要处理「补发期间又来新片」的竞态 —— 快照一次拿到当前全文，天然没这个洞。
   *
   * ★ 按 **`sessionId`** 找（不是 requestId）：requestId 是渲染层生成的，
   *   侧边栏从没听过它；它只知道「我在看哪条会话」。
   *
   * @param {{ sessionId?: string }} [payload]
   */
  function handleResume(payload) {
    const want = String(payload?.sessionId ?? '') || String(bridge?.getActiveSession?.() ?? '')
    if (!want) return fail(P.ERR.NO_SESSION, '没说是哪条会话')
    /* 同一会话可能有多条快照（连发两条）—— 取最近的那条 */
    let best = null
    for (const snap of snapshots.values()) {
      if (snap.sessionId !== want) continue
      if (!best || snap.at > best.at) best = snap
    }
    if (!best) return fail(P.ERR.NO_SESSION, '那条会话没有正在跑的回复（重新发一条即可）')
    /*
     * 回的是 `seq` + **全文**（不是分片）：侧边栏据此把已有文字一次补齐，
     * 之后只认 `seq` 更大的分片（缺口语义见设计说明 §3.2）。
     */
    return {
      ok: true,
      sessionId: best.sessionId,
      seq: best.seq,
      text: best.text,
      reasoning: best.reasoning,
      done: best.done,
    }
  }

  /** 推一份分片给扩展（没绑桥就只记快照）—— 推的是**增量**，不含全文 */
  function pushDelta(requestId, sessionId, seq, type, text, done) {
    bridge?.push?.(P.KIND.CHAT_EVENT, { requestId, sessionId, seq, type, text, done })
  }

  /** 结构性事件（done / error / tool…）推到侧边栏：让「正在跑」这类状态也看得见 */
  const PUSH_TYPES = new Set(['content', 'reasoning', 'done', 'aborted', 'error', 'tool_start', 'tool_end'])

  /**
   * 旁听一轮里的事件（由 `register-handlers.cjs` 包过的 `send` 出口调 —— 也就是
   * 渲染层**收到的同一批**，content/reasoning 已经过 50ms 合批）。
   *
   * ★ 只读旁听：不改流向、不改事件形状 —— 渲染层那条路一个字节都不受影响。
   * ★ `sessionId` 从 `streams` 反查（`chat:event` 的 payload 里没有它）——
   *   这正是给 `streams.set` 补 `sessionId` 字段的用处。
   *
   * @param {{ type?: string, text?: string, content?: string, reasoning?: string, requestId?: string }} event
   */
  function onChatEvent(event) {
    const requestId = String(event?.requestId ?? '')
    if (!requestId) {
      /* 这条 warn 很重要：没有 requestId 就认不出是哪一轮，整条流都会丢 */
      log?.warn?.(`扩展通道：旁听收到一条没有 requestId 的 chat:event（type=${String(event?.type ?? '')}）`)
      return
    }
    const sessionId = String(streams.get(requestId)?.sessionId ?? '')
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
    /*
     * ★ `done` 那片带**全文**（不是空 text）：侧边栏分片可能丢（广播没人听、
     *   面板刚打开），最后一片拿全文覆盖，一次把缺的补回来 —— 两边最终一致。
     */
    pushDelta(requestId, snap.sessionId, snap.seq, type, type === 'done' ? snap.text : (event.text ?? ''), snap.done)

    if (snap.done) {
      /* 延迟清：立刻清的话，「刚跑完就重连」会问不到（用户看到空内容） */
      const rid = requestId
      const timer = setTimeout(() => snapshots.delete(rid), KEEP_AFTER_DONE_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  return {
    handleSend,
    handleResume,
    onChatEvent,
    /** 装配时绑上管道那头的桥（`push` 与 `getActiveSession` 都从它取） */
    setBridge(b) {
      bridge = b ?? null
    },
    /** 自检用 */
    snapshotOf(requestId) {
      return snapshots.get(requestId) ?? null
    },
  }
}

module.exports = { createChatRelay, EXT_SEND, KEEP_AFTER_DONE_MS }
