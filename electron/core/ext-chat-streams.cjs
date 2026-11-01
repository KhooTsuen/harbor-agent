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

/**
 * 结构性事件推到侧边栏：让「正在跑」这类状态也看得见（content/reasoning 是增量）。
 *
 * ★ 2026-10-20 修了一个**静默失效**：原来写的是 `tool_start` / `tool_end`，但渲染层
 *   真实发出的事件名是 `agent.tool.started` / `agent.tool.completed`（见
 *   `src/types/chat-events.ts`）—— 那两个名字**永远命中不了**，于是「当前在跑哪个工具」
 *   从来没推到过侧边栏，而**没有任何报错**。这类跨模块名字对不上只能靠真跑或对源码看出来。
 *
 * M02-B 起任务卡还要两样：相位（`turn_start` / `plan`）与「等待确认」（`confirm_request`）。
 */
const PUSH_TYPES = new Set([
  'content',
  'reasoning',
  'done',
  'aborted',
  'error',
  /* 工具调用（真名；保留旧名防止外部调用方仍按旧名发） */
  'agent.tool.started',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.tool.progress',
  'tool_start',
  'tool_end',
  /* M02-B 任务卡：相位 */
  'turn_start',
  'plan',
  'turn_end',
  /* M02-B 任务卡：等待确认（侧边栏要能显示「在等你确认」，否则用户不知道卡在哪） */
  'confirm_request',
  /*
   * ★ 2026-10-21：重试必须让侧边栏知道（见下面 `retry` 分支）。
   *   不加这一项时，一次 timeout / 限流触发的重试会让同一段正文在侧边栏里出现**两遍**：
   *   上一次尝试已经流出去的字不会因为重试而消失，而重试后模型会把同样的话再说一遍。
   *   主窗口那边由 `reconcileFinalRounds` 在收尾时合并，侧边栏没有那一步，所以只有它看得出来。
   */
  'retry',
])

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

  /**
   * @type {Map<string, {
   *   sessionId: string, seq: number, text: string, reasoning: string,
   *   done: boolean, at: number,
   *   roundText: number, roundThink: number,
   * }>}
   */
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
      snap = { sessionId, seq: 0, text: '', reasoning: '', done: false, at: 0, roundText: 0, roundThink: 0 }
      snapshots.set(requestId, snap)
    }
    snap.at = Date.now()
    /*
     * ★ 2026-10-21：「本轮从第几个字符开始」——重试要回滚到这儿。
     *   一轮 agent 循环里会调多次模型，每次 `turn_start` 就是新的一段。
     *   正文和思考各记一个长度（两者的累积量不同，不能共用一个数）。
     *   回滚到本轮起点而不是清空，才能保住前面几轮已经说过的内容。
     */
    if (type === 'turn_start') {
      snap.roundText = snap.text.length
      snap.roundThink = snap.reasoning.length
    }
    /* done 带完整正文 —— 用它兜底（分段快照可能因为合批还没到齐） */
    if (type === 'done') {
      snap.text = String(event.content ?? snap.text)
      snap.reasoning = String(event.reasoning ?? snap.reasoning)
      snap.done = true
    } else if (type === 'retry') {
      /*
       * ★ 重试 = 上一次尝试作废（`loop-model.cjs:151` 之后会重新从头请求）。
       *   已经流出去的字必须退回去，否则重试后模型再说一遍，这一轮就是两遍。
       *   只退回本轮起点：前面几轮的内容是有效的。
       */
      snap.text = snap.text.slice(0, snap.roundText)
      snap.reasoning = snap.reasoning.slice(0, snap.roundThink)
    } else if (type === 'aborted' || type === 'error') {
      snap.done = true
    } else if (type === 'content' && typeof event.text === 'string') {
      snap.text += event.text
    } else if (type === 'reasoning' && typeof event.text === 'string') {
      snap.reasoning += event.text
    }

    if (!PUSH_TYPES.has(type)) return
    snap.seq += 1
    /* `done` / `retry` 推**全文**（前者兜底，后者是回滚后的正文，侧边栏据此覆盖） */
    const outText = type === 'done' || type === 'retry' ? snap.text : (event.text ?? '')
    pushDelta(requestId, snap.sessionId, snap.seq, type, outText, snap.done)

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
    for (const [requestId, snap] of snapshots) {
      if (snap.sessionId !== want) continue
      if (!best || snap.at > best.at) best = { ...snap, requestId }
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
