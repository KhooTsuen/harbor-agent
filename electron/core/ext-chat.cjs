/**
 * 侧边栏发消息 / 流式回复（Phase 3b；3c 加了「选会话」）
 *
 * ── ★ 为什么主进程**不自己跑**这一轮（C-α，用户 2026-10-16 拍板）──
 *
 * assistant 的落盘（`src/stores/thread/replyPersistence.ts`）**只在渲染层** ——
 * 主进程一个字节都不落（3b 设计说明 §1 逐条查过）。主进程若自己调 `loop.run()`，
 * 那一轮就没有 replyPersistence → 回复**不落盘**，而且落盘形状还要再造一份
 * （硬约束 #9 的同一件事写两遍）。所以这条路的定位是**校验 + 转发 + 旁听**：
 *
 *   侧边栏 chat:send
 *     → 这里校验（主窗口在不在 / 那条会话忙不忙）→ `chat:event` 推给**渲染层**
 *     → 渲染层照常走它自己那条 turn → 既有链路落盘 ✓
 *   同时旁听每一轮的事件（`onChatEvent`）→ 更新快照 + 推给扩展（侧边栏看流式）
 *
 * ── 为什么「忙」要在**这里**拦 ────────────────────────────────
 *
 * 渲染层遇到「这条会话在跑」是**静默排队**（AG-025），侧边栏用户看不到那个队列 ——
 * 会以为消息丢了。所以**拒绝 + 人话**（§6）。
 *
 * ── 快照是本阶段唯一新增的状态 ───────────────────────────────
 * `Map<requestId, {sessionId, seq, text, reasoning, done, at}>`，不复用 `events.cjs`：
 * 它刻意不落流式增量、环形缓冲全体共享（长回答就冲光）。`done` 后延迟 60s 清。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

const P = require('./ext-protocol.cjs')
/* 快照 + 旁听（M02-A：从本文件搬出去 —— 那边自成一体）；KEEP 常量原样再导出，调用点不变 */
const { createStreamStore, KEEP_AFTER_DONE_MS } = require('./ext-chat-streams.cjs')

/** 推给渲染层的事件名（走 `chat:event` channel，**不是新 IPC 通道**） */
const EXT_SEND = 'ext:send'
/** 侧边栏点 ＋ → 请渲染层新建一条并切过去（Phase 3c） */
const EXT_NEW = 'ext:new'
/**
 * M02-A2：侧边栏点「停止」→ 请渲染层停掉那条会话正在跑的一轮。
 *
 * ★ 与 `EXT_SEND` / `EXT_NEW` 同一条通道（`chat:event`），**不新增 IPC 通道**。
 *   真相在渲染层：只有它手里有 AbortController（见 handleAbort 的注释）。
 */
const EXT_ABORT = 'ext:abort'

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

  /*
   * 快照与「旁听一轮」整块在 `ext-chat-streams.cjs`（那边自成一体，133 行）——
   * 本文件只管「发 / 选 / 停」。`push` 用闭包**晚取** bridge（装配时才 setBridge）。
   */
  const streamStore = createStreamStore({
    sessionIdOfRequest: (rid) => String(streams.get(rid)?.sessionId ?? ''),
    push: (kind, payload) => bridge?.push?.(kind, payload),
    log,
  })
  /**
   * 管道那头的桥 —— 装配时给（`setBridge`）。
   *
   * 为什么要晚绑：bridge 需要本模块的**分派**，本模块需要 bridge 的
   * `push` 与 `getActiveSession` —— 互相依赖。所以先各自建好，再一行绑上。
   */
  let bridge = null


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
   * 侧边栏现在在看哪条（Phase 3c）。
   *
   * ★ 与 `activeSessionId`（Harbor 主窗口当前打开的那条）**是两回事** ——
   *   用户 2026-10-16 拍板「侧边栏独立看一条，主窗口不动」。空串 = 还没选：
   *   这时发消息**新建一条**再发，而不是悄悄落进主窗口那条（用户报的 bug 2）。
   */
  let selectedSessionId = ''
  /** 刚请渲染层新建了一条，等它回报真实 id（见 noteActiveSession） */
  let awaitingNew = false

  /** 把「侧边栏在看哪条」推给扩展（显式选 / 自动新建之后都调） */
  function pushSelected() {
    bridge?.push?.(P.KIND.SESSION_SELECTED, { sessionId: selectedSessionId })
  }

  /** 侧边栏显式选了某条 —— **只改它自己，主窗口不动** */
  function handleSelect(payload) {
    const id = String(payload?.sessionId ?? '')
    if (!id) return fail(P.ERR.NO_SESSION, '没说是哪条会话')
    selectedSessionId = id
    awaitingNew = false
    pushSelected()
    log?.info?.(`扩展通道：侧边栏切到会话 ${id}（主窗口不动）`)
    return { ok: true, sessionId: id }
  }

  /** 侧边栏点 ＋：新建一条、两侧都切过去 */
  function handleNew() {
    if (!getMainWindow || !getMainWindow()) {
      return fail(P.ERR.NO_WINDOW, 'Harbor 主窗口不在（先打开 Harbor 再新建）')
    }
    awaitingNew = true
    send('chat:event', { type: EXT_NEW })
    return { ok: true }
  }

  /**
   * 渲染层换了当前会话 —— 侧边栏那套跟着学。
   *
   * 学两种情形：① 刚请它新建的（`awaitingNew`）；② 手里那个还是 `pending_…`
   * 临时 id（渲染层刚把磁盘会话建好，见 `useAppStore` 的 `replaceThreadId`）。
   * 不学的话主进程就留着一个作废的 id，侧边栏下一条消息会发丢。
   */
  function noteActiveSession(id) {
    const next = String(id ?? '')
    if (!next) return
    const isTemp = (v) => v.startsWith('pending_')
    if (awaitingNew || (selectedSessionId && isTemp(selectedSessionId) && next !== selectedSessionId)) {
      selectedSessionId = next
      awaitingNew = false
      pushSelected()
    }
  }

  /**
   * 侧边栏请求「发一条消息」。
   *
   * @param {{ text?: string, sessionId?: string }} [payload]
   */
  function handleSend(payload) {
    const text = String(payload?.text ?? '').trim()
    if (!text) return fail(P.ERR.INTERNAL, '消息是空的')

    /* C-α：执行者是渲染层 —— 它不在这一轮根本跑不起来，所以早拒并回人话（§1）。
       默认配置下关窗口 = hideToTray（main.cjs:135），窗口没销毁，这条不会命中。 */
    if (!getMainWindow || !getMainWindow()) {
      return fail(P.ERR.NO_WINDOW, 'Harbor 主窗口不在（先打开 Harbor 再发）')
    }

    /* Phase 3c：侧边栏指明的优先（它才是真相源）；没带就退回主进程记的那个 */
    const sessionId = String(payload?.sessionId ?? '') || selectedSessionId
    if (sessionId) selectedSessionId = sessionId
    /* 一条都没选 → 请渲染层新建一条再发（不再落进主窗口那条） */
    if (!sessionId) {
      awaitingNew = true
      send('chat:event', { type: EXT_SEND, newSession: true, text })
      log?.info?.('扩展通道：一条都没选 → 请渲染层新建一条再发')
      return { ok: true, sessionId: '', created: true }
    }
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
   * 侧边栏重连 / 重开后要「上次流到哪」。回**一份快照**而不是补发历史分片 ——
   * 补发要留着所有分片（内存 × 条数）还要处理竞态，快照一次拿全文天然没这个洞。
   *
   * ★ 按 `sessionId` 找（不是 requestId）：requestId 是渲染层生成的，侧边栏从没听过。
   *
   * @param {{ sessionId?: string }} [payload]
   */
  function handleResume(payload) {
    const want =
      String(payload?.sessionId ?? '') || selectedSessionId || String(bridge?.getActiveSession?.() ?? '')
    if (!want) return fail(P.ERR.NO_SESSION, '没说是哪条会话')
    const best = streamStore.latestOf(want)
    if (!best) return fail(P.ERR.NO_SESSION, '那条会话没有正在跑的回复（重新发一条即可）')
    /* 回 `seq` + **全文**（不是分片）：侧边栏一次补齐，之后只认更大的 seq */
    return {
      ok: true,
      sessionId: best.sessionId,
      seq: best.seq,
      text: best.text,
      reasoning: best.reasoning,
      done: best.done,
    }
  }
  /* 快照与旁听整块在 `ext-chat-streams.cjs` —— 上面那个 streamStore。 */
  const onChatEvent = (event) => streamStore.onChatEvent(event)

  /**
   * M02-A2：**停止**这条会话正在跑的那一轮（规格：「停止按钮真正取消相关请求」）。
   *
   * ★ 为什么不由主进程直接 abort：执行者是**渲染层**（C-α，见文件头）——
   *   主进程手里没有那个 AbortController。所以这里只「请渲染层去停」
   *   （推 `ext:abort`，与 `ext:send` / `ext:new` 同一条通道，零新增 IPC 通道），
   *   渲染层接住后调它现成的 `stopActiveRequest`（唯一一处真正 abort 的实现）。
   *
   * ★ **没在跑时如实说没停**（不假装停掉了）—— 这与 M04 那批「没执行就说没执行」同一口径。
   *   判据用 `busyRequestOf`（它扫的是 streams 的 sessionId 字段，是既有唯一口径）。
   *
   * @param {{ sessionId?: string }} [payload]
   */
  function handleAbort(payload) {
    const sessionId = String(payload?.sessionId ?? '') || selectedSessionId
    if (!sessionId) return fail(P.ERR.NO_SESSION, '没说是哪条会话')
    if (!busyRequestOf(sessionId)) {
      return fail(P.ERR.NO_SESSION, '这条对话没有正在跑的回复（没什么可停的）')
    }
    send('chat:event', { type: EXT_ABORT, sessionId })
    log?.info?.(`扩展通道：侧边栏请求停止会话 ${sessionId} → 交给渲染层停`)
    return { ok: true, sessionId }
  }

  return {
    handleSend,
    handleResume,
    /* Phase 3c：侧边栏选会话 / 点 ＋ / 渲染层回报当前会话 */
    handleSelect,
    handleNew,
    noteActiveSession,
    onChatEvent,
    /* M02-A2：停止这条会话正在跑的一轮（回执如实 —— 没在跑就说没停） */
    handleAbort,
    /** 装配时绑上管道那头的桥（`push` 与 `getActiveSession` 都从它取） */
    setBridge(b) {
      bridge = b ?? null
    },
    /** 自检用（快照住在 ext-chat-streams，这里转发） */
    snapshotOf(requestId) {
      return streamStore.snapshotOf(requestId)
    },
    /** 自检用：侧边栏现在在看哪条 */
    selectedOf() {
      return selectedSessionId
    },
  }
}

module.exports = { createChatRelay, EXT_SEND, EXT_NEW, EXT_ABORT, KEEP_AFTER_DONE_MS }
