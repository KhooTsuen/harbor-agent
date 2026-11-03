/**
 * 侧边栏的**消息列表**（历史 + 正在流的那一轮）—— 纯函数，2026-11-03
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────
 *
 * 它要把**两份来源**合成一条时间线：
 *   · 历史：`session-messages` 从磁盘读来的（`{id, role, text, toolRuns, …}`）
 *   · 当前：`useChatStream` 收 `chat:event` 累加出来的那一轮（`TurnView`）
 *
 * 合并规则有两处极易写错，而写错的表现都是「看起来没问题」：
 *
 *   ① **历史里可能已经有这一轮了**。判据是「历史最后一条用户消息 = 这一轮的 ask」。
 *      ★ 2026-11-03 真机修：以前这条判据只在 `live.done` 时才跑，于是**流式期间**
 *      提问出现两遍 —— 用户那条消息在按下发送的瞬间就落了盘（渲染层立刻写
 *      `role: 'user'`），历史里已有，而 `live.ask` 又被接了一遍。
 *      现在「提问在不在历史里」与「跑没跑完」分开判：前者按正文比，后者只决定
 *      回答要不要接。
 *   ② **流式期间历史是旧的**。刚发出的那一问还没落盘，历史里当然没有 ——
 *      这时必须把「正在流的那一轮」接在末尾，否则用户发完就看不到自己那句话
 *      （旧版侧边栏正是因为只认流、不认历史，看不出这个缺口）。
 *   ③ **磁盘上的回答可能只是半截快照**。流式落盘是分段追加（`partial: true`），
 *      一轮跑完时收尾那条是**异步**写的；侧边栏在 `done` 那一刻重读历史，经常
 *      只读到半截版（还被 `collapseByKey` 标成 `interrupted`）。而内存里的
 *      `live.text` 是全文 —— 所以「谁长用谁」，长的那份赢。
 *
 * 纯函数放这里还有一个好处：自检能直接跑（`scripts/selftest/groups/` 有先例）。
 *
 * ── 与主窗口的口径对齐 ────────────────────────────────────────
 *
 * 不自造第二套消息形状：字段名沿用在用的那份（`role` / `text` / `toolRuns` /
 * `timestamp` / `error`），渲染按角色分成「用户气泡」与「助手正文」两支 ——
 * 与 `src/components/chat/message/UserMessage.tsx` + `MessageItem.tsx` 同一个分法。
 */

/**
 * 一条工具记录（侧边栏这边要显示的东西）。
 *
 * 字段名与磁盘上的 `toolRuns[]` 逐字一致（`name` / `ok` / `ms` / `summary` /
 * `output`）—— 内核 `ext-session-messages.cjs` 的 `briefToolRuns` 就按这几个键
 * 瘦身，所以这里不另造字段名（硬约束 #9）。
 */
export interface SideToolRun {
  name: string
  ok: boolean
  ms?: number
  /** 参数摘要（「读了哪个文件」）—— 主窗口那行靠它，侧边栏也靠它 */
  summary?: string
  /** 失败原因（只有失败的那条带） */
  output?: string
}

/**
 * 内核回来的 `toolRuns` → 侧边栏那份。
 *
 * 为什么要过一遍而不是直接信：这条数据来自**主进程 / 磁盘**（外部数据），
 * `ok` 缺字段时不能让界面把失败画成成功 —— 与内核 `briefToolRuns` 的
 * `ok: r?.ok !== false` 同一个口径（没有明确说失败就算成功，那正是它的语义）。
 */
export function normalizeToolRuns(raw: unknown): SideToolRun[] {
  if (!Array.isArray(raw)) return []
  const out: SideToolRun[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const one = item as Record<string, unknown>
    const name = typeof one.name === 'string' ? one.name.trim() : ''
    if (!name) continue
    const ms = typeof one.ms === 'number' && Number.isFinite(one.ms) ? one.ms : undefined
    out.push({
      name,
      ok: one.ok !== false,
      ...(ms !== undefined && ms > 0 ? { ms } : {}),
      ...(typeof one.summary === 'string' && one.summary.trim() ? { summary: one.summary } : {}),
      ...(typeof one.output === 'string' && one.output.trim() ? { output: one.output } : {}),
    })
  }
  return out
}

/** 一条要显示的消息（历史条目与流式那一轮统一成这个形状） */
export interface SideMessage {
  /** 列表 key（历史用内核给的 m<索引>，流式那条用 `live`） */
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 这条不是用户手打的（`'extension'`：扩展读到的网页 / 操作回执）—— 画成折叠卡，见 MessageStream */
  source?: string
  /** 正文被截断过（历史侧受字节预算约束） */
  truncated?: boolean
  timestamp?: number
  toolRuns?: SideToolRun[]
  /** 思考（默认折叠） */
  reasoning?: string
  /** 出错那句话 */
  error?: string
  /** 上次运行被打断 */
  interrupted?: boolean
  durationMs?: number
  /** 这条是**正在流**的那一轮（不是磁盘来的）—— 界面据此画光标 */
  live?: boolean
  /** 正在流、还没收尾 */
  streaming?: boolean
}

/** `useChatStream` 里那一轮的形状（与 `TurnBubble.tsx` 的 TurnView 同口径） */
export interface LiveTurn {
  ask: string
  text: string
  seq: number
  done: boolean
  error?: string | null
  /**
   * 这一轮的思考（流式累加）。
   *
   * ★ 2026-11-04 补：`reasoning` 分片**一直**是推到侧边栏的
   *   （`electron/core/ext-chat-streams.cjs` 的 `PUSH_TYPES` 里有它），但
   *   `useChatStream` 以前只认 `content` —— 思考被静默丢掉，于是
   *   「正在思考…」永远不可能出现。现在它是这条时间线的一部分：
   *   流式中由这里传进来，跑完后由历史那份（带全文）接上。
   */
  reasoning?: string
}

/**
 * 合并「历史 + 正在流的那一轮」。
 *
 * @param history 磁盘读来的消息（已按发生顺序）
 * @param live 侧边栏手里那一轮（可能为 null）
 * @returns 显示用的一条时间线（新数组，不改入参）
 */
export function mergeMessages(history: SideMessage[], live: LiveTurn | null): SideMessage[] {
  const out = Array.isArray(history) ? [...history] : []
  if (!live) return out
  /* 只有思考也照样接（一轮的头几片往往全是思考，正文一个字还没出） */
  if (!live.ask && !live.text && !live.reasoning) return out

  const ask = String(live.ask ?? '').trim()
  const text = String(live.text ?? '')
  const thinking = String(live.reasoning ?? '')
  const streaming = !live.done && !live.error

  /*
   * ① 这一轮的提问在历史里吗？**按正文比历史最后一条用户消息**。
   *
   *    ★ 不再看 `live.done`：用户那条消息在按下发送时就已经落盘了，
   *    流式期间历史里一定已经有了 —— 以前只在 done 时判，于是提问显示两遍。
   */
  let askedAt = -1
  if (ask) {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      /* 扩展送进来的记录也是 role: 'user'，但它不是用户说的话 —— 跳过 */
      if (out[i].role !== 'user' || out[i].source === 'extension') continue
      if (out[i].text.trim() === ask) askedAt = i
      break /* 只认最后一条用户消息：这一轮紧跟它后面 */
    }
  }

  /* ② 那一轮的回答在哪（提问之后、下一条用户消息之前的第一条 assistant） */
  let replyAt = -1
  if (askedAt >= 0) {
    for (let i = askedAt + 1; i < out.length; i += 1) {
      const m = out[i]
      if (m.role === 'user') break
      if (m.role === 'assistant') {
        replyAt = i
        break
      }
    }
  } else if (ask) {
    /* ③ 历史里还没有这一问（刚发、还没落盘）→ 接在末尾 */
    out.push({ id: 'live-ask', role: 'user', text: live.ask, live: true, timestamp: Date.now() })
  }

  if (replyAt >= 0) {
    const old = out[replyAt]
    const older = String(old.text ?? '')
    /*
     * ④ 历史里有那条回答 —— 用**更完整**的那份。
     *
     *    磁盘上的一轮是分段追加的（`partial: true`），收尾那条异步写；侧边栏在
     *    `done` 那一刻重读常常只拿到半截版（还被标成 interrupted）。内存里的
     *    `live.text` 才是全文，所以「谁长用谁」；反过来 live 是空壳时不许把
     *    历史里的好内容冲掉（`done` 后 60 秒流缓存就清了，那时 live 可能只剩空）。
     */
    if (text.length >= older.length && (text.trim() || live.error)) {
      /*
       * 思考也「谁长用谁」（同一条判据，不另立一套）：磁盘那份可能还没收尾，
       * 内存里的是全文；反过来历史那份要是更长（live 已清），就留历史的。
       */
      const olderThink = String(old.reasoning ?? '')
      const think = thinking.length >= olderThink.length ? thinking : olderThink
      out[replyAt] = {
        ...old,
        text: text || older,
        ...(think ? { reasoning: think } : {}),
        ...(live.error ? { error: live.error } : {}),
        /* 覆盖成全量后，那两条降级提示必须撤掉，否则界面一直说「没写完」 */
        truncated: false,
        interrupted: false,
        streaming,
        live: streaming,
      }
    }
    return out
  }

  /* ⑤ 历史里没有这条回答（或连提问都还没有）→ 接在末尾 */
  if (!text && !live.error && !streaming && !thinking.trim()) return out
  out.push({
    id: 'live',
    role: 'assistant',
    text,
    live: true,
    streaming,
    ...(thinking ? { reasoning: thinking } : {}),
    ...(live.error ? { error: live.error } : {}),
  })
  return out
}

/**
 * 历史被截断时要说的那句（`dropped > 0` 才有）。
 *
 * ★ 为什么不写「只显示最近 60 条」这种把数字写死的话：条数上限是内核侧的常数
 *   （`ext-session-messages.cjs` 的 `MAX_MESSAGES`），这边写死就会漂 ——
 *   用内核回的 `dropped` 说「还有 N 条更早的没显示」，永远对得上。
 */
export function truncatedHint(dropped: number): string {
  const n = Number(dropped ?? 0)
  if (!(n > 0)) return ''
  return `还有 ${n} 条更早的消息没显示（侧边栏只带最近一段，完整内容在 Harbor 主窗口）`
}
