/**
 * 开工前澄清（AG-053）—— 校验与措辞
 *
 * 需求原话：「AI 在任务开始时，主动把需要用户拿主意的地方摆出来；每个选项下方
 * 写清『因为 X，所以会有 Y 效果』（具体数字或事实，不是主观判断）；用户可以自由
 * 回答、补充想法、跳过；用户答完后才进入执行。」
 *
 * 这个文件是那条链路的**纯函数**（不碰 Electron、不碰 IO）：
 *   ① `normalize()` —— 模型给的提问**不能全信**：条数、选项数、effect 有没有实质内容、
 *      默认选项有没有，都要过一遍。坏的**剔除并报告**，不整条报废（一次问坏一个
 *      问题就把整张卡丢掉，用户什么也看不到，更糟）。
 *   ② `render()` —— 用户的答复 / 跳过 / 离场 / 无人值守，翻成给模型看的一段文本。
 *
 * 按**对话**累积的那两件事（静音计数、无人值守标记）在 `clarify-session.cjs`
 * （批③ 拆出去的，理由见那边文件头）；它们仍从这里转出去，调用方不用改。
 * 离场计时在 `clarify-timeout.cjs`（依赖注入，也不 require electron）。
 *
 * ⚠️ **不在这个文件里 require('electron')** —— 自检和单测要在没有 Electron 的
 *    环境里直接调它（项目里那条「内核不 require electron」的硬约定）。
 */

/** 一次最多问几个（问多了就是审问） */
const MAX_QUESTIONS = 3
/** 每个问题最多几个选项（4 个够分了，再多用户看不过来） */
const MAX_OPTIONS = 4
const MAX_QUESTION_CHARS = 200
const MAX_LABEL_CHARS = 60
const MAX_EFFECT_CHARS = 200

/**
 * 「effect 里有没有具体事实」的宽松判据：有数字，或者有量词。
 * 只做**警告**不做剔除 —— 提示词层已经硬要求写具体数字/事实，
 * 这里再硬拦会把「因为要跑测试，所以多花 30 秒」这种正常的漏掉（数字在别处），
 * 反而误伤。警告会进日志，用来回头调提示词（见 CLARIFY_RULE）。
 */
const MEASURE_WORDS = [
  '文件',
  '行',
  '个',
  '条',
  '项',
  '次',
  '轮',
  '天',
  '小时',
  '分钟',
  '秒',
  '字节',
  'KB',
  'MB',
  'GB',
  '份',
  '处',
]

function concrete(text) {
  const value = String(text ?? '')
  if (/\d/.test(value)) return true
  return MEASURE_WORDS.some((word) => value.includes(word))
}

/* ══════════════════════════════════════════════════════════════
   校验 + 措辞（纯函数）

   按**对话**记的那两件事（静音、无人值守）在 `clarify-session.cjs`：
   那边是累积的状态，这边是「给什么、回什么」，改动的理由不同。
   它们照旧从这里转出去，调用方（`tools/ask_user.cjs` / 自检）不用改。
   ══════════════════════════════════════════════════════════════ */

const session = require('./clarify-session.cjs')

function text(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

/** 规范一个选项；坏选项返回 null */
function option(raw) {
  const label = text(raw?.label, MAX_LABEL_CHARS)
  if (!label) return null
  const effect = text(raw?.effect, MAX_EFFECT_CHARS)
  return { label, effect, concrete: concrete(effect) }
}

/**
 * 校验并规范模型给的提问。
 *
 * @param {unknown} raw 形如 `[{ question, options: [{label, effect}], allowFreeform, defaultValue }]`
 * @returns {{ questions: Array<{question: string, options: Array<{label: string, effect: string, concrete: boolean}>,
 *            allowFreeform: boolean, defaultValue: string, defaultFrom: 'model'|'first', index: number}>,
 *            dropped: Array<{question: string, reason: string}>,
 *            warnings: Array<{question: string, warning: string}> }}
 */
function normalize(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = { questions: [], dropped: [], warnings: [] }

  list.forEach((item, index) => {
    const question = text(item?.question, MAX_QUESTION_CHARS)
    if (!question) {
      out.dropped.push({ question: '', reason: '问题是空的' })
      return
    }
    if (out.questions.length >= MAX_QUESTIONS) {
      out.dropped.push({ question, reason: `一次最多问 ${MAX_QUESTIONS} 个` })
      return
    }

    const options = (Array.isArray(item?.options) ? item.options : [])
      .slice(0, MAX_OPTIONS + 1)
      .map(option)
      .filter(Boolean)
      .slice(0, MAX_OPTIONS)
    const allowFreeform = item?.allowFreeform !== false

    if (options.length === 0 && !allowFreeform) {
      out.dropped.push({ question, reason: '既没有选项、又不允许自由回答' })
      return
    }

    /* effect 没实质内容的：警告（提示词层要求的「具体数字或事实」没做到） */
    for (const one of options) {
      if (!one.effect) {
        out.warnings.push({ question, warning: `选项「${one.label}」没写效果（因为 X 所以 Y）` })
      } else if (!one.concrete) {
        out.warnings.push({
          question,
          warning: `选项「${one.label}」的效果里没有数字也没有量词：「${one.effect}」`,
        })
      }
    }

    /*
     * 默认选项：模型没标就用第一个（并记下来是「退让」来的）。
     * ★ 需求：默认必须是「改动最小、最容易回滚、风险最低」的那个 ——
     *   那是**提示词层**的硬要求（CLARIFY_RULE）；这里只能保证「有一个默认」，
     *   保证不了它是不是最保守的。填不上默认的问题**不剔除**：
     *   留一个默认 + 一条警告，比让用户看不到这个问题好。
     */
    const asked = text(item?.defaultValue, MAX_LABEL_CHARS)
    const matched = options.find((one) => one.label === asked)
    const fallback = options[0]?.label ?? ''
    if (asked && !matched) {
      out.warnings.push({ question, warning: `默认选项「${asked}」不在选项里，退回第一个` })
    }
    const defaultValue = matched?.label ?? fallback
    const defaultFrom = matched ? 'model' : 'first'
    if (options.length > 0 && defaultFrom === 'first') {
      out.warnings.push({ question, warning: `没标默认选项，取第一个「${defaultValue}」` })
    }

    out.questions.push({
      question,
      options,
      allowFreeform,
      defaultValue,
      defaultFrom,
      index,
    })
  })

  return out
}

/* ══════════════════════════════════════════════════════════════
   措辞：把结果翻成给模型看的一段话
   ══════════════════════════════════════════════════════════════ */

const TAIL_ON_SKIP =
  '用户跳过了这次澄清。按你自己判断最稳妥的做法开工，并在回复里用一行说明「我选了 X，因为 Y」。'

/** 无人值守（定时任务）时的开场白 —— 和「用户跳过」必须分开说，否则模型会以为用户刚才在 */
const TAIL_UNATTENDED =
  '这是一次**无人值守**的运行（定时任务），没有人能回答下面这些问题。按每条的默认选项开工，并在回复里用一行说明「我选了 X（默认），因为 Y」。'

/**
 * 「先不做了」（AG-053 批⑤）—— 卡片左边第一个出口。
 *
 * 和「跳过」**必须分开说**：跳过是「别问了，你看着办」（接着干），这个是
 * 「先停，别动手」（这一轮就此收尾）。说成同一句的话，模型会一边写着交接
 * 一边把活干完 —— 用户点的是「先不做」，回来却发现文件已经改了。
 *
 * 交接里要写「下次从哪一步接着做」：界面那边同时把这轮 pause 住，任务在
 * 台账上变成 paused，用户回头点「继续」时接的就是这几行。
 */
const TAIL_ON_CANCEL =
  '用户点了「先不做了」：**这次先不做**。立刻停手 —— 不要再调任何工具、不要改任何文件。' +
  '把这个任务已经查到的结论、以及「下次从哪一步接着做」，用几行写清楚，然后结束这一轮' +
  '（他会从任务列表点「继续」接着做）。'

/**
 * 「换个说法」（AG-053 批⑤）—— 卡片上的第二个出口。
 *
 * ★ 必须明确要求**换措辞、换选项**：原样再发一遍是用户最不想看到的
 *   （他刚说过「这版没说清」）。也别让他把已经问清的再问一遍。
 */
const TAIL_ON_REPHRASE =
  '用户点了「换个说法」：他觉得刚才那几个问题没说清（或者选项不合适）。' +
  '**重新组织问题再问一次** —— 换个角度、换一组更具体的选项，别把同一版问题原样重复；' +
  '已经问清的那几条不用再问。如果你确实问不出更好的，就直接按最稳妥的做法开工，并说明理由。'

/**
 * @param {Array} questions `normalize()` 的输出
 * @param {{ answers?: Array<{question: string, choice?: string, text?: string}>, skipped?: boolean,
 *           timeout?: boolean, unattended?: boolean, cancelled?: boolean,
 *           rephrase?: boolean }} reply
 */
function render(questions, reply = {}) {
  /*
   * ★ 两个「退出口」也**必须排在跳过前面**（批⑤ 新加）：
   *   「先不做了」和「换个说法」回话时 `approved` 都是 false —— 也就是说
   *   上游完全可以（而且 `handlers/chat-confirm.cjs` 里就是这么写的）把它们
   *   连同 `skipped: true` 一起给过来。写在跳过后面的话，用户点了「换个说法」，
   *   模型收到的却是「用户跳过了这次澄清」，然后自己开工去了 —— 而用户还在等
   *   一个重新问的卡。批② 离场判定踩过同一个坑（见下面那段）。
   */
  if (reply.cancelled === true) return TAIL_ON_CANCEL
  if (reply.rephrase === true) return TAIL_ON_REPHRASE

  /*
   * ★ 超时**必须排在跳过前面**：真机上 `askClarify` 超时回的是
   *   `{ skipped: true, timeout: true, answers: [] }` —— 两种都带 skipped。
   *   先判 skipped 的话，离场会被当成「用户说跳过」：模型永远不知道自己是
   *   按**默认选项**继续的，界面也不会出现［默认］标记，用户回来一看是懵的
   *   （「我什么都没说，你怎么就改了？」）。
   *   批② 真机验证抓到的就是这个 —— 自检当时的假数据没带 skipped，所以才全绿。
   */
  if (reply.skipped === true && reply.timeout !== true) return TAIL_ON_SKIP

  const byQuestion = new Map(
    (Array.isArray(reply.answers) ? reply.answers : []).map((one) => [
      String(one?.question ?? ''),
      one,
    ]),
  )

  const lines = reply.unattended === true
    ? [TAIL_UNATTENDED]
    : reply.timeout === true
      ? ['用户离场了，这次按**默认选项**继续（下面每条都标了是默认还是他选的）：']
      : ['用户的答复：']

  questions.forEach((item, index) => {
    const answer = byQuestion.get(item.question)
    const choice = text(answer?.choice, MAX_LABEL_CHARS) || item.defaultValue
    const chosen = item.options.find((one) => one.label === choice)
    const free = text(answer?.text, 400)
    const why = chosen?.effect ? `（因为：${chosen.effect}）` : ''
    /* 没人在场采纳的（离场 / 无人值守）都标「默认」—— 用户事后要分得清哪条是别人替他定的 */
    const auto = reply.timeout === true || reply.unattended === true
    const tag = auto && choice === item.defaultValue ? '［默认］' : ''
    lines.push(`${index + 1}. ${item.question} → ${tag}${choice}${why}`)
    if (free) lines.push(`   他还补充：${free}`)
  })

  if (reply.timeout !== true && reply.unattended !== true) {
    lines.push('', '按这些答复开工。答复里没提到的部分，你自己判断，别再来回问。')
  }
  return lines.join('\n')
}

module.exports = {
  MAX_QUESTIONS,
  MAX_OPTIONS,
  TAIL_ON_SKIP,
  TAIL_UNATTENDED,
  TAIL_ON_CANCEL,
  TAIL_ON_REPHRASE,
  normalize,
  render,
  concrete,
  /* 按对话记的状态（实现在 clarify-session.cjs，这里转出去） */
  ...session,
}
