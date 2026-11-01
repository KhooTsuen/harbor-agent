/**
 * 折叠**有损**时的程序级闸门（P0-1）
 *
 * `history-fold.wholeOf` 超过 `USER_FOLD_CAP` 时会写「中间 N 字没有进入本次请求」，但那只是
 * **提示词**：模型可以装看见直接开干。用户要的是程序级 —— **调 Provider 之前就停手**，
 * 当前对话里说清「哪一轮、缺多少」并给恢复路径。判定只此一处（`chat-run.cjs` 调它）。
 *
 * ── 「已提示」≠「已获确认」（2026-10-23 第六轮）────────────────
 *
 * 上一版把这两件事当一件：首次阻断记「提示过」，下一条消息（**不论内容**）就放行，还把折叠块
 * 写成「用户已看到并选择继续」。提示过 ≠ 用户同意，那句假话比不提示更糟。现在两份状态：
 * `notified`（只影响措辞，**不参与放行**）与 `confirmed`（只有 `confirm()` 写，按会话 + 指纹）。
 *
 * ── 两条恢复路径（都可判定，不靠猜）──────────────────────────
 *
 * ① **明确确认**：确认卡上点「按现有信息继续」→ `confirm()` 记指纹 → 这一轮放行。
 * ② **补充到位**：缺失那一段**原样**补进最新消息 → 逐字包含（不是关键词 / 长度）→ 放行，不写 confirmed。
 * 普通追问 / 换对话 / 重开应用都不算确认：`confirmed` 按会话分、只在进程内。
 *
 * ── 2026-10-27 真机验收补的第三条判据（见 `vanished`）──────────
 *
 * 被拦的消息留在会话里 → 下次发送历史变长 → 同一段原话从「折叠」退化成「**整轮被省略**」。
 * 省略不进 `lossy`，闸门就看不见 → **未确认也放行**。现在只要「提示过、没确认的原话
 * 这次连摘要都没进请求」就继续拦。
 *
 * ⚠️ 不 require electron、不写盘；**不存用户原话**（状态里只有指纹与计数），
 *   判据用的原文从本次请求的 `rawHistory` 临时取，用完即弃。
 */

/* 「请先问用户」那句、指纹口径、上限都只有一处定义（history-fold.cjs）—— 这里只引用 */
const { USER_INCOMPLETE, fingerprint, USER_FOLD_CAP } = require('./history-fold.cjs')
const { textOf } = require('./message-text.cjs')

/** 确认卡上两个出口的**唯一文案**（chat-run 与自检都从这儿取，别再各写一份） */
const CHOICE_CONTINUE = '按现有信息继续'
const CHOICE_SUPPLEMENT = '我先补充缺的原话'

/** 放行后替换掉 `USER_INCOMPLETE` 的那句：**如实**说明缺失还在 */
const ACK =
  '⚠ 用户已明确选择「按现有信息继续」：**缺失的那一段原话仍然没有进入本次请求**（他不是补齐了）。别再向他重复这件事；缺的内容真要用到，直接问他本人，不要自己补写。'

/** 补充路径放行时替换成这句：缺失的字在最新那条消息里，逐字包含 */
const ACK_SUPPLIED =
  '⚠ 缺失的那一段原话，用户已**原样补在最新一条消息里**（那边有全文）。这个折叠块本身仍然不是全文，别把这里当成原文完整版。'

/**
 * 按对话分的那两份状态（只在进程内，不落盘）：
 * `notified` = 提示过几次（只影响措辞）；`confirmed` = 哪些指纹**获得了明确确认**。
 * @type {Map<string, { notified: Map<string, number>, confirmed: Set<string> }>}
 */
const state = new Map()

const keyOf = (sessionId) => String(sessionId ?? '')

function stateOf(key) {
  let one = state.get(key)
  if (!one) {
    one = { notified: new Map(), confirmed: new Set() }
    state.set(key, one)
  }
  return one
}

/** 只认「真有损」的条目（缺字数为 0 的不算） */
function lossyList(lossy) {
  const list = Array.isArray(lossy) ? lossy : []
  return list.filter((one) => one && typeof one.fp === 'string' && one.fp && Number(one.missing) > 0)
}

/** 「哪一轮」：`turnsBack` 由 `takeTurns` 给（倒数第几轮）；拿不到就说得含糊些 */
function whereOf(one) {
  const back = Number(one?.turnsBack)
  return Number.isFinite(back) && back > 0 ? `倒数第 ${back} 轮` : '更早的一轮'
}

/** 折叠保留的是「开头一半 + 结尾一半」—— 缺的就是中间这一段（与 wholeOf 同口径） */
function missingMiddle(full) {
  const half = Math.floor(USER_FOLD_CAP / 2)
  if (full.length <= USER_FOLD_CAP) return ''
  return full.slice(half, full.length - half)
}

/**
 * 这条有损段是不是已经**补充到位**了 —— 判据是**逐字包含**（不是关键词 / 长度）：
 * 在 `rawHistory` 里按指纹找回原文，取被截掉的中间区间，看最新一条**要发出去**的文本里有没有它。
 * `supplied` 必须是**要发给模型的那一份**（落文件 / 折叠之后），否则「补了但没发出去」也算补齐。
 */
function covered(one, rawHistory, supplied) {
  const text = String(supplied ?? '')
  if (!text) return false
  const origin = originOf(one.fp, rawHistory)
  if (!origin) return false
  const middle = missingMiddle(origin)
  if (!middle) return false
  return text.includes(middle)
}

/** 在 `rawHistory` 里按指纹找回原话（找不到 = 这段已经在会话里消失，不归这里管） */
function originOf(fp, rawHistory) {
  return (
    (Array.isArray(rawHistory) ? rawHistory : [])
      .map((message) => textOf(message?.content))
      .find((full) => full && fingerprint(full) === fp) ?? ''
  )
}

/** 那段原话是**倒数第几轮**（按 `rawHistory` 里的用户消息数倒推；算不出就说「更早的一轮」） */
function turnsBackOf(origin, rawHistory) {
  const users = (Array.isArray(rawHistory) ? rawHistory : [])
    .filter((message) => message?.role === 'user')
    .map((message) => textOf(message?.content))
  const at = users.findIndex((text) => text === origin)
  if (at < 0) return 0
  return users.length - at
}

/**
 * 「刚提示过的那段原话，这一轮**连摘要都没进请求**」—— 2026-10-27 真机验收逮到的洞。
 *
 * 被拦的消息留在会话里 → 下次发送的历史多两条 → 同一段原话从「折叠」退化成
 * 「**整轮被省略**」（`takeTurns` 预算装不下就丢整轮）。省略不进 `lossy`，闸门就看不见，
 * 于是**未确认也静默放行**（日志实证：`19/23 折叠+600字→阻断`，下一次 `18/25 省略→直接发出`）。
 *
 * 判据：提示过、未确认、原文仍在 `rawHistory`，而 `delivered`（这次真要发的那份）里
 * 没有任何一条用户消息**包含它的开头**。折叠块留着开头一半 → 命中不误报；整轮丢弃 → 拦住。
 * 没被提示过的原话不参与（「更早轮次被省略」照旧不打扰用户）。
 */
function vanished(one, rawHistory, delivered) {
  const origin = originOf(one.fp, rawHistory)
  if (!origin) return false
  const head = origin.slice(0, 40)
  return !(Array.isArray(delivered) ? delivered : []).some(
    (message) => message?.role === 'user' && textOf(message?.content).includes(head),
  )
}

/** 「缺了多少」的唯一说法 —— 错误气泡与确认卡必须同一口径，否则用户得自己换算 */
function howOf(still) {
  const first = still[0] ?? {}
  if (still.some((one) => one.kind === 'dropped')) {
    return `整段原话这一轮**连摘要都没进请求**（原文 ${Number(first.total) || 0} 字全丢）`
  }
  const missing = still.reduce((sum, one) => sum + Number(one.missing), 0)
  return `原文 ${Number(first.total) || 0} 字，缺 ${missing} 字`
}

/** 给用户看的那段话（会进当前对话的错误气泡）——每一句都对应一个可核对的事实 */
function messageOf(still, stateOne) {
  const first = still[0] ?? {}
  const times = Number(stateOne?.notified.get(first.fp) ?? 0)
  const round = times + 1
  return [
    `这一轮没有发给模型：${whereOf(first)}的用户原话没有完整进入本次请求（${howOf(still)}，指纹 ${String(first.fp ?? '')}）。`,
    '缺掉的那一段里可能有你还没看到的约束，接着做等于我在替你猜 —— 所以先停在这里，一个请求都没发出去。',
    `要接着做只有两条路：① 再发一条消息，在那张卡上点「${CHOICE_CONTINUE}」；② 把缺的那段原话原样补到下一条消息里（整段贴回来就不再挡）。`,
    '普通追问、切换对话、重开应用都不算确认：我不替你猜「补没补全」。',
    ...(round > 1 ? [`（这是第 ${round} 次提醒：上一条消息没有确认，我不会把它当成同意。）`] : []),
  ].join('\n')
}

/**
 * 确认卡上问什么（形状交给 `clarify.normalize` 校验，这里只描述内容）。
 * @param {Array<object>} still 还没获得确认的有损段
 */
function askSpec(still) {
  const first = still[0] ?? {}
  const missing = still.reduce((sum, one) => sum + Number(one.missing), 0)
  return [
    {
      question: `这一轮没有发给模型：${whereOf(first)}的用户原话没有完整进入本次请求（${howOf(still)}）。怎么接着做？`,
      options: [
        {
          label: CHOICE_CONTINUE,
          effect: `这轮照发：缺的 ${missing} 字仍然不在请求里，模型只知道缺多少、不知道内容。`,
        },
        {
          label: CHOICE_SUPPLEMENT,
          effect: '这轮不发（0 次请求）：你把缺的那段原样补到下一条消息里，补全了就自动放行。',
        },
      ],
      allowFreeform: false,
      defaultValue: CHOICE_SUPPLEMENT,
    },
  ]
}

/**
 * 这次发送要不要拦。
 *
 * @param {{ sessionId?: string, lossy?: Array<object>, rawHistory?: Array<object>, supplied?: string,
 *           delivered?: Array<object> }} input
 *          `supplied` = 最新一条**要发给模型**的文本（判定「补充到位」）；
 *          `delivered` = 这一次真要发出去的那份历史（判定「整轮被省略」）
 * @returns {{ blocked: boolean, message: string, pending: Array<object>, supplied: string[] }}
 */
function inspect({ sessionId = '', lossy = [], rawHistory = [], supplied = '', delivered = [] } = {}) {
  const one = stateOf(keyOf(sessionId))
  /* ① 折叠类：这次被折成摘要、还没获确认的那些 */
  const pending = lossyList(lossy).filter((item) => !one.confirmed.has(item.fp))
  /* ② 省略类：提示过、没确认、原文还在会话里，但这一轮整段不见了（见 vanished 的注释） */
  const gone = [...one.notified.keys()]
    .filter((fp) => !one.confirmed.has(fp) && !pending.some((item) => item.fp === fp))
    .map((fp) => {
      const item = { fp, total: 0, missing: 0, turnsBack: 0, kind: 'dropped' }
      const origin = originOf(fp, rawHistory)
      if (!origin) return null
      return vanished(item, rawHistory, delivered)
        ? { ...item, total: origin.length, missing: origin.length, turnsBack: turnsBackOf(origin, rawHistory) }
        : null
    })
    .filter(Boolean)
  const all = [...pending, ...gone]
  if (all.length === 0) return { blocked: false, message: '', pending: [], supplied: [] }
  const filled = all.filter((item) => covered(item, rawHistory, supplied))
  const still = all.filter((item) => !filled.includes(item))
  if (still.length === 0) {
    return { blocked: false, message: '', pending: [], supplied: filled.map((item) => item.fp) }
  }
  return {
    blocked: true,
    message: messageOf(still, one),
    pending: still,
    supplied: filled.map((item) => item.fp),
  }
}

/** 记「已经提示过这一段」—— **不参与放行**，只让措辞能说清「第几次提醒」。每次阻断调一次。 */
function markNotified({ sessionId = '', lossy = [] } = {}) {
  const list = lossyList(lossy)
  if (list.length === 0) return 0
  const one = stateOf(keyOf(sessionId))
  let added = 0
  for (const item of list) {
    const times = Number(one.notified.get(item.fp) ?? 0)
    if (times === 0) added += 1
    one.notified.set(item.fp, times + 1)
  }
  return added
}

/** 记下「用户**明确**选择了按现有信息继续」—— 只有确认卡上的那个出口能调它。 */
function confirm({ sessionId = '', lossy = [] } = {}) {
  const list = lossyList(lossy)
  if (list.length === 0) return 0
  const one = stateOf(keyOf(sessionId))
  let added = 0
  for (const item of list) {
    if (one.confirmed.has(item.fp)) continue
    one.confirmed.add(item.fp)
    added += 1
  }
  return added
}

/**
 * 放行用的那一份历史：把折叠块里「先请用户确认」换成**如实**的说明。
 * ★ 只改这次发给模型的那一份（`foldTurn` 新造的对象），会话文件与气泡不动。
 * @param {Array<object>} history
 * @param {'confirmed' | 'supplied'} [mode] 放行靠明确确认还是补充到位
 */
function acknowledge(history, mode = 'confirmed') {
  const list = Array.isArray(history) ? history : []
  const replacement = mode === 'supplied' ? ACK_SUPPLIED : ACK
  let changed = false
  const out = list.map((message) => {
    if (message?.role !== 'user') return message
    const text = String(message.content ?? '')
    if (!text.includes(USER_INCOMPLETE)) return message
    changed = true
    return { ...message, content: text.split(USER_INCOMPLETE).join(replacement) }
  })
  return changed ? out : list
}

/** 清进程内状态（重开应用 / 自检用）。不给 sessionId 就全清。 */
function reset(sessionId) {
  if (sessionId === undefined) state.clear()
  else state.delete(keyOf(sessionId))
}
/** 某条对话当前的两份状态（只读快照） */
function snapshot(sessionId) {
  const one = stateOf(keyOf(sessionId))
  return { notified: [...one.notified.keys()], confirmed: [...one.confirmed] }
}

module.exports = {
  inspect,
  markNotified,
  confirm,
  acknowledge,
  reset,
  snapshot,
  askSpec,
  CHOICE_CONTINUE,
  CHOICE_SUPPLEMENT,
  ACK,
  ACK_SUPPLIED,
  USER_INCOMPLETE,
}
