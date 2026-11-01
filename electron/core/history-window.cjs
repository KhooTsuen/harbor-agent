/**
 * 历史窗口：按**完整轮次**截取（P0-1，2026-10-23）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 *
 * 以前两条发送路径都按**消息条数**切：
 *   · `handlers/chat.cjs` —— `rawHistory.slice(-historyLimit)`（展开工具之后切）
 *   · `core/session-read.cjs` —— `afterCompact.slice(-limit)`（展开工具之前切）
 *
 * 两个后果都是真机复现过的：
 *   ① 展开后按条数切会把**一组工具调用切两半**：assistant(tool_calls) 进来，
 *      对应的 tool 消息被切掉（或反过来）—— 上游直接 400「tool_call_id 无对应」。
 *      用户的原话是「30 次工具调用之后发送『那个地方接着改』，最终请求里只剩这一句」。
 *   ② 两条路径的「条数」不是同一种东西（一条数展开后的、一条数展开前的），
 *      于是「刚聊完」和「重开会话」模型看到的窗口**本来就不一样**。
 *
 * ── 这里的规则（唯一一处）──────────────────────────────────────
 *
 *   · 轮次起点 = 一条 `user` 消息。后面跟着的 assistant / tool 都归这一轮。
 *   · 截取单位 = 轮次：要么整轮进来，要么整轮出去 —— 因此工具组**不可能被切半**。
 *   · 预算仍按消息条数算（设置里那个 historyLimit 口径不变），但切点只落在轮次边界。
 *   · 至少保留 `minTurns` 个完整轮次（默认 1）：最后一轮一定要在，否则模型
 *     看不到用户这次到底要什么（`lastUserText` 也靠它）。
 *   · 开头连续的系统消息（压缩摘要）**钉住**，不参与预算、不会被切 ——
 *     它代表的是被压掉的整段历史，切掉等于把指令依据全丢了。
 *
 * ── 2026-10-23 第二轮：整轮都装不下时**折叠**，不是丢掉（P0-1 的「只剩这一句」）
 *
 * 上一版的判据（最后一轮整轮在）过了，但真机症状还在：上一轮跑了 30 次工具调用、
 * 展开成 61 条消息，而默认预算是 20 条 —— 于是那一轮**整轮被丢**，最终请求里只剩
 * 「那个地方接着改」这一句。模型不知道「那个地方」是哪、也不知道当初定了什么约束。
 *
 * 现在的规则：装不下一整轮时，先把**最近** `foldTurns`（默认 2）轮折叠，再判断
 * 折出来的几条放不放得下。折叠的实现在 `history-fold.cjs`（这里只切轮次、算预算）。
 *
 * ── 2026-10-23 第三轮：折出来的**角色不变**，工具输出不再是 system ──────────
 *
 * 上一版把一整轮压成**一条 `system`**，两处都出问题：
 *   · 原话被 `clip(text, 400)` 只留开头 —— 约束在末尾时**从请求里消失了**，
 *     摘要却写着「目标 / 约束 / 要求都在原文里」（那句话是假的）；
 *   · 工具输出（文件 / 网页 / 命令正文）被写进 system，拿到了**指令地位**。
 *
 * 现在的折叠产出**原角色 + 低信任数据**：user 原话（长就挑整句、并标注哪几句没进）
 * → 一条明确标记的「低信任数据」消息（只有条数 / 字数 / 指纹，正文不搬，角色不是
 * system）→ assistant 结论。折叠块里没有任何 `tool_calls` / `tool` 消息 —— 工具协议
 * 天然合法。
 *
 * 调用方：`handlers/chat.cjs`（内存历史）与 `core/session-read.cjs`（磁盘历史）。
 * 两边必须用同一份 —— 这是硬约束 9 在本项目里第七次被踩之后加的。
 */

/* 文本口径（字符串原样 / 多模态数组只取 text）只有一处实现：message-text.cjs */
const { textOf } = require('./message-text.cjs')

/**
 * 按 `user` 消息切轮次。第一条不是 user 时也自成一轮（内容不丢）。
 *
 * @param {Array<{ role?: string }>} messages
 * @returns {Array<{ messages: Array<object> }>}
 */
function groupTurns(messages) {
  const list = Array.isArray(messages) ? messages : []
  const turns = []
  let current = null
  for (const message of list) {
    /* 开头那串系统消息（压缩摘要）算「前置段」，单独成一组并永远钉住 */
    const isSystemHead = current === null && message?.role === 'system'
    if (current === null || (message?.role === 'user' && !isSystemHead)) {
      current = { messages: [] }
      turns.push(current)
    }
    current.messages.push(message)
  }
  return turns
}

/** 这个轮次是不是「开头的系统段」（压缩摘要）—— 钉住，不参与预算 */
function isPinnedTurn(turn) {
  const list = turn?.messages ?? []
  return list.length > 0 && list.every((m) => m?.role === 'system')
}

/*
 * 折叠摘要本身搬到了 `history-fold.cjs`（这里已经 253 行）。
 * 那边解释了两个边界：长原话只挑整句并如实标注没进去的部分；工具输出只给可核对摘要，
 * 且**不是 system 角色**（文件内容 / 网页正文不能拿到指令地位）。
 */
const { foldTurn, TEXT_CAP, TOOL_LINES } = require('./history-fold.cjs')

/**
 * 从尾部往前取完整轮次，直到条数超过预算。
 *
 * @param {Array<object>} messages
 * @param {number} budget 消息条数预算（<=0 = 一条都不取）
 * @param {{ minTurns?: number, foldTurns?: number }} [options]
 *        `minTurns` = 至少保留几个完整轮次（默认 1）；
 *        `foldTurns` = 最多把几轮折成摘要（默认 2，0 = 不折叠，退回「整轮丢」的老行为）
 * @returns {{ kept: Array<object>, dropped: number, droppedTurns: number, foldedTurns: number,
 *            lostChars: number, lossy: Array<{ fp: string, total: number, missing: number }>,
 *            turns: number }}
 *          `lostChars` = 用户原话真的没进请求的字数（0 = 完整）；`lossy` 是逐条明细
 *          （哪一段、原文多少字、缺多少、指纹）—— 发送入口（`core/fold-gate.cjs`）拿它拦。
 */
function takeTurns(messages, budget, { minTurns = 1, foldTurns = 2 } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const empty = { kept: [], dropped: 0, droppedTurns: 0, foldedTurns: 0, lostChars: 0, lossy: [], turns: 0 }
  if (list.length === 0) return empty

  const turns = groupTurns(list)
  const pinned = turns.filter(isPinnedTurn)
  const movable = turns.filter((turn) => !isPinnedTurn(turn))

  if (!(Number(budget) > 0)) {
    return {
      ...empty,
      kept: pinned.flatMap((turn) => turn.messages),
      dropped: movable.reduce((sum, turn) => sum + turn.messages.length, 0),
      droppedTurns: movable.length,
      turns: turns.length,
    }
  }

  const keptTurns = []
  let count = 0
  let keep = 0
  let folded = 0
  /* 用户原话真的没进请求的字数（折叠有损时 > 0）—— 必须随结果报出去 */
  let lost = 0
  /** 逐条有损明细（发送入口据此拦下来问用户） */
  const lossy = []
  for (let i = movable.length - 1; i >= 0; i -= 1) {
    const size = movable[i].messages.length
    /* 够 minTurns 之前一律整轮放进（最后一轮是「这轮到底要什么」，不能用摘要代替） */
    if (keep < minTurns || count + size <= Number(budget)) {
      keptTurns.unshift(movable[i])
      count += size
      keep += 1
      continue
    }
    /*
     * 装不下整轮 → 折成「原角色 + 低信任数据」那一组消息（默认最多 2 轮）。
     * ★ 折叠只发生在「已经满足 minTurns」之后，所以最后一轮永远是完整原文。
     * ★ 折出来的可能不止一条（user 原话 / 工具摘要 / assistant 结论），
     *   所以预算按**实际折出来的条数**算 —— 否则会悄悄超预算。
     * ★ `lost` 是用户原话真的没进请求的字数（`history-fold.wholeOf` 报的）——
     *   随结果一起返回，调用方要如实说「缺了多少」，不能当成完整原文。
     */
    if (folded < foldTurns && count + 1 <= Number(budget)) {
      const digest = foldTurn(movable[i])
      const messages = Array.isArray(digest?.messages) ? digest.messages : []
      if (messages.length > 0 && count + messages.length <= Number(budget)) {
        keptTurns.unshift({ messages })
        count += messages.length
        folded += 1
        lost += Number(digest?.missing) || 0
        if (Array.isArray(digest?.lossy)) {
          /* `turnsBack` = 倒数第几轮（用户要看到「哪一轮不完整」，只给字数不够） */
          const back = movable.length - i
          lossy.push(...digest.lossy.map((one) => ({ ...one, turnsBack: back })))
        }
        continue
      }
    }
    break
  }

  const kept = [...pinned.flatMap((turn) => turn.messages), ...keptTurns.flatMap((turn) => turn.messages)]
  return {
    kept,
    dropped: list.length - kept.length,
    /* 折叠进来的那几轮是「有摘要」的，不算「被省略」 */
    droppedTurns: movable.length - keep - folded,
    foldedTurns: folded,
    /* 用户原话没进请求的字数（0 = 完整）。> 0 时调用方必须如实说，不许当成完整 */
    lostChars: lost,
    /* 逐条明细（哪一段、原文多少字、缺多少、指纹）—— 发送入口拿它拦 */
    lossy,
    turns: turns.length,
  }
}

/**
 * 「这次省略 / 折叠了什么」的一句话说明 —— 只进日志，不进提示。
 *
 * 文档要求「预算不足时应当记录省略了哪轮、保留了什么」，所以这里给出可读数字：
 * 折叠了几轮、省略了几轮、被省掉的那轮开头是什么（截前 20 字）。
 */
function describeWindow(result, list = []) {
  const dropped = Number(result?.droppedTurns) || 0
  const folded = Number(result?.foldedTurns) || 0
  if (dropped <= 0 && folded <= 0) return ''
  const head = (value) => textOf(value).replace(/\s+/g, ' ').trim().slice(0, 20)
  const kept = Array.isArray(result?.kept) ? result.kept : []
  const users = (Array.isArray(list) ? list : []).filter((m) => m?.role === 'user')
  const keptUsers = kept.filter((m) => m?.role === 'user').length
  const droppedHead = head(users[users.length - 1 - keptUsers]?.content)
  const parts = []
  if (folded > 0) {
    parts.push(`最近 ${folded} 轮已折成摘要（原话与结论保留原角色；工具只留条数 / 字数 / 指纹，不搬正文）`)
  }
  const lost = Number(result?.lostChars) || 0
  if (lost > 0) {
    parts.push(`⚠ 其中 ${lost} 字用户原话没进请求（发送入口会先拦下来请用户补充或确认）`)
  }
  if (dropped > 0) {
    parts.push(
      droppedHead ? `省略了更早的 ${dropped} 轮（从「${droppedHead}…」起）` : `省略了更早的 ${dropped} 轮`,
    )
  }
  return parts.join('；')
}

module.exports = {
  groupTurns,
  takeTurns,
  describeWindow,
  isPinnedTurn,
  foldTurn,
  TEXT_CAP,
  TOOL_LINES,
}
