/**
 * 侧边栏要的「这条会话说过什么」—— 切片 + 瘦身（2026-11-03）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 侧边栏以前只显示**当前这一轮**（`chat:event` 流式推来的），打开面板时
 * 看不到这条会话之前说过什么 —— 用户的原话是「侧边栏对话流内的已有功能应于
 * Harbor agent 保持一致，尽量减少分裂感」。主窗口显示的是**整条会话**
 * （`session:load` → `storedToUi`），侧边栏要一致就得也拿到同一批消息。
 *
 * ── 为什么不能直接把 session.load() 的结果丢过去 ────────────────
 *
 * 三条硬理由，每条都会真出事：
 *
 * ① **单帧上限 1 MiB**（`ext-protocol.cjs` 的 `MAX_FRAME`，native messaging 的
 *    host→Edge 官方上限）。开发版实测有一条 **141 MB** 的会话 —— 原样塞进去
 *    必然超限，然后被换成降级失败帧，用户看到「拿不到历史」而不知道为什么。
 * ② **侧边栏只有 400px 宽**，一次渲染上千条消息既慢又没人看。
 * ③ 磁盘记录里带 `images`（data URL，单张可能几 MB）与 `rounds` 全量时间线
 *    —— 侧边栏一条都用不上（图不显示、时间线用工具行代替）。
 *
 * 所以这里做「取尾部 + 逐条瘦身 + 总预算兜底」。**判据是字节数，不是条数**：
 * 60 条短消息和 60 条各 6 千字的长消息差一个数量级。
 *
 * ── 脱敏 ──────────────────────────────────────────────────────
 *
 * 不在这里再过一遍 `redact`：会话落盘时**已经**走过 `session-io.serializeLine`
 * 的 `scrubStorage` + `redact`（见那个函数的注释），读回来的就是脱敏后的内容。
 * 再兜一遍的代价是对几十万字跑一串正则 —— 那会把主进程事件循环按住，
 * 换来的只是一份「已经做过的事」。
 *
 * ⚠️ 本模块**纯函数、不 require 任何东西** —— 自检能直接跑，也不给主进程
 *    加依赖（与 `ext-kinds.cjs` 同一个路子）。
 */

/** 最多带几条消息（从尾部取 —— 用户最关心刚才说了什么） */
const MAX_MESSAGES = 60

/** 单条正文上限（字符）。超过就截断并标记 `truncated` */
const MAX_TEXT = 6000

/** 单条工具输出上限（字符）—— 工具那行只显示名字与成败，输出基本用不上 */
const MAX_TOOL_OUTPUT = 240

/**
 * 单条工具参数摘要上限（字符）。
 *
 * 磁盘上的 `toolRuns[].summary` 本来就有（`src/lib/schemas.ts` 声明了它，
 * 注释原话是「不声明它，重开会话后工具行的『读了哪个文件』就没了」）——
 * 侧边栏这条路径以前**漏带**，于是同一组工具在主窗口说「读取 README.md」、
 * 在侧边栏只说「读取文件」。这里补上，字段名沿用同一个，不另造。
 */
const MAX_TOOL_SUMMARY = 120

/**
 * 总预算（字节，按 UTF-8 估算）：
 * 1 MiB 是硬上限，留出 300 KB 余量给帧头 / JSON 转义 / 其它字段。
 */
const BUDGET_BYTES = 700 * 1024

/** 近似字节数：中文一字 3 字节，用它做预算比 `length` 保守得多 */
function bytesOf(text) {
  const s = String(text ?? '')
  let n = 0
  for (var i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1 }
    else n += 3
  }
  return n
}

/** 截断到 n 个字符（**不切坏代理对**：往回退到非高代理位） */
function clip(text, n) {
  const s = String(text ?? '')
  if (s.length <= n) return { text: s, cut: false }
  let end = n
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: s.slice(0, end), cut: true }
}

/** 工具记录只留画一行要的东西（名字 / 参数摘要 / 成败 / 耗时） */
function briefToolRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return []
  return runs.slice(0, 30).map((r) => {
    const summary = clip(r?.summary ?? '', MAX_TOOL_SUMMARY)
    return {
      name: String(r?.name ?? '工具'),
      /* 参数摘要（磁盘上已有）：侧边栏拿它拼「读取 README.md」那一行 */
      ...(summary.text.trim() ? { summary: summary.text } : {}),
      ok: r?.ok !== false,
      ms: Number(r?.ms ?? 0),
      /* 失败的把原因带一句 —— 侧边栏要能看出「为什么红了」，不能只给个红点 */
      output: String(r?.ok === false ? clip(r?.output ?? '', MAX_TOOL_OUTPUT).text : ''),
    }
  })
}

/**
 * 一组工具记录占多少字节（预算用）。
 *
 * ★ 2026-11-04：以前 `sizes` 只算正文 + 思考 + 400 的固定开销，工具记录整个没算 ——
 *   而一条消息最多带 30 条工具、每条现在还有 up to 120 字摘要 + 240 字失败原因，
 *   于是一条「正文很短、工具很多」的消息会把预算估小，帧可能顶到 1 MiB。
 */
function toolBytesOf(runs) {
  if (!Array.isArray(runs)) return 0
  let n = 0
  for (let i = 0; i < runs.length; i += 1) {
    const r = runs[i]
    n += 120
    n += bytesOf(r?.summary ?? '') + bytesOf(r?.output ?? '')
  }
  return n
}

/**
 * 一条磁盘记录 → 侧边栏那条消息。
 *
 * 字段名**故意与 UI 侧同口径**（`role` / `content` / `timestamp` / `toolRuns`），
 * 少一层翻译。`tool` 角色（工具回执）不单独出一条：
 * 它的信息已经在那条 assistant 的 `toolRuns` 里，再出一条就是同一件事显示两遍。
 *
 * @returns {object|null} null = 这条不进侧边栏
 */
function briefOf(stored, index) {
  const role = String(stored?.role ?? '')
  if (role === 'tool') return null
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null

  const body = clip(stored?.content ?? '', MAX_TEXT)
  const thinking = clip(stored?.reasoning ?? '', MAX_TEXT)
  const error = String(stored?.error ?? '')
  const toolRuns = briefToolRuns(stored?.toolRuns)

  /* 三样都空的跳过：一条什么都没有的记录在界面上是个空块 */
  if (!body.text.trim() && !error && toolRuns.length === 0) return null

  return {
    /* 索引当 id：侧边栏只用来做 key，不参与任何写回（侧边栏**不落盘**） */
    id: `m${index}`,
    role,
    text: body.text,
    /**
     * 扩展送进来的（网页正文 / 页面操作回执）—— **必须带**，否则侧边栏只能按
     * role 画，把它当成用户说的话（2026-11-04 真机：四张原文卡糊满一屏）。
     * 值原样透传，界面自己决定怎么显示。
     */
    ...(stored?.source ? { source: String(stored.source) } : {}),
    /** 正文被截断了（界面据此说一句「这条太长，只显示开头」） */
    truncated: body.cut,
    timestamp: Number(stored?.ts ?? 0),
    toolRuns,
    /* 思考只在有内容时带（侧边栏默认折叠，跟主窗口一样） */
    ...(thinking.text ? { reasoning: thinking.text, reasoningTruncated: thinking.cut } : {}),
    ...(error ? { error } : {}),
    ...(stored?.interrupted || stored?.aborted ? { interrupted: true } : {}),
    ...(typeof stored?.durationMs === 'number' && stored.durationMs > 0
      ? { durationMs: stored.durationMs }
      : {}),
  }
}

/**
 * `session.load()` 的结果 → 侧边栏要的那一段。
 *
 * @param {{ messages?: Array<object> }} detail `electron/core/session-read.cjs` 的 load 返回值
 * @param {{ maxMessages?: number, budgetBytes?: number }} [opts] 自检用（省得造 60 条数据）
 * @returns {{ messages: Array<object>, total: number, dropped: number, truncated: boolean }}
 *   `total` = 这条会话一共几条可用消息；`dropped` = 因为条数/预算被丢掉的条数
 */
function messagesOf(detail, opts = {}) {
  const all = Array.isArray(detail?.messages) ? detail.messages : []
  const maxMessages = Number(opts.maxMessages ?? MAX_MESSAGES) || MAX_MESSAGES
  const budget = Number(opts.budgetBytes ?? BUDGET_BYTES) || BUDGET_BYTES

  /* 先全量瘦身（保持顺序），再决定丢哪儿 —— 先切条数会漏掉「最后一条特别长」的情况 */
  const briefed = []
  let total = 0
  for (let i = 0; i < all.length; i += 1) {
    const one = briefOf(all[i], i)
    if (!one) continue
    total += 1
    briefed.push(one)
  }

  /* ① 条数上限：从尾部取（用户最关心刚才说了什么） */
  let keep = briefed.length > maxMessages ? briefed.slice(briefed.length - maxMessages) : briefed

  /* ② 字节预算：仍超就从**头部**继续丢 —— 越近的越留 */
  let used = 0
  const sizes = keep.map(
    (m) => bytesOf(m.text) + bytesOf(m.reasoning ?? '') + 400 + toolBytesOf(m.toolRuns),
  )
  used = sizes.reduce((a, b) => a + b, 0)
  let from = 0
  while (used > budget && from < keep.length - 1) {
    used -= sizes[from]
    from += 1
  }
  if (from > 0) keep = keep.slice(from)

  const dropped = total - keep.length
  return {
    messages: keep,
    total,
    dropped,
    /* 有东西被丢 → 界面说一句「只显示最近 N 条」，不假装这就是全部 */
    truncated: dropped > 0,
  }
}

/**
 * 造一个「读这条会话说过什么」的处理器（`session:messages`）。
 *
 * ★ 为什么放在这个文件而不是 `ext-ops.cjs`：那边贴着 300 行红线（硬约束 #2），
 *   而这一条是「取尾部 + 瘦身 + 预算」的自然延伸 —— 判据与用法在同一个文件里，
 *   改上限时不用跳两个文件。`session` 由调用方注入（那边才有 `session.load`），
 *   本模块仍然**不 require 任何东西**。
 *
 * @param {{
 *   session: { load: (id: string) => any },
 *   getSelected?: () => string,
 *   getActive?: () => string,
 *   fail: (code: string, message: string) => object,
 *   ERR: { NO_SESSION: string },
 * }} deps
 */
function createSessionMessages(deps) {
  const { session, fail, ERR } = deps
  const getSelected = deps.getSelected ?? (() => '')
  const getActive = deps.getActive ?? (() => '')

  return function sessionMessages(payload) {
    /* 顺序与 `page-context-ingest` 那套一致：显式指定 → 侧边栏选中的 → 主窗口开着的 */
    const want = String(payload?.sessionId ?? '') || String(getSelected() ?? '') || String(getActive() ?? '')
    if (!want) return fail(ERR.NO_SESSION, '还没选中对话 —— 先从列表里选一条')
    let detail = null
    try {
      detail = session.load(want)
    } catch (error) {
      return fail(ERR.NO_SESSION, `读不到这条对话（${error instanceof Error ? error.message : error}）`)
    }
    if (!detail || !detail.meta) return fail(ERR.NO_SESSION, '这条对话已不存在，请刷新列表后重试')
    const part = messagesOf(detail, { maxMessages: payload?.maxMessages, budgetBytes: payload?.budgetBytes })
    return {
      sessionId: want,
      title: String(detail.meta.title ?? ''),
      messages: part.messages,
      /* 条数与截断如实报：界面据此说「还有 N 条没显示」，不假装这就是全部 */
      total: part.total,
      dropped: part.dropped,
      truncated: part.truncated,
    }
  }
}

module.exports = {
  messagesOf,
  createSessionMessages,
  MAX_MESSAGES,
  MAX_TEXT,
  MAX_TOOL_SUMMARY,
  BUDGET_BYTES,
}
