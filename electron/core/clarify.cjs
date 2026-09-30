/**
 * 开工前澄清（AG-053）—— 校验、静音、措辞
 *
 * 需求原话：「AI 在任务开始时，主动把需要用户拿主意的地方摆出来；每个选项下方
 * 写清『因为 X，所以会有 Y 效果』（具体数字或事实，不是主观判断）；用户可以自由
 * 回答、补充想法、跳过；用户答完后才进入执行。」
 *
 * 这个文件是那条链路的**纯逻辑**（不碰 Electron、不碰 IO），三件事：
 *   ① `normalize()` —— 模型给的提问**不能全信**：条数、选项数、effect 有没有实质内容、
 *      默认选项有没有，都要过一遍。坏的**剔除并报告**，不整条报废（一次问坏一个
 *      问题就把整张卡丢掉，用户什么也看不到，更糟）。
 *   ② `skips` —— 「同一对话连续跳过 2 次就不再主动问」的计数器（**纯内存、
 *      不写偏好**：用户连拒两次是「这次别打扰我」，不是「以后都别问」）。
 *   ③ `render()` —— 用户的答复/超时/跳过，翻成给模型看的一段文本。
 *
 * ⚠️ **不在这个文件里 require('electron')** —— 自检和单测要在没有 Electron 的
 *    环境里直接调它（项目里那条「内核不 require electron」的硬约定）。
 *    离场检测在 `clarify-timeout.cjs`，那边也是依赖注入。
 */

/** 一次最多问几个（问多了就是审问） */
const MAX_QUESTIONS = 3
/** 每个问题最多几个选项（4 个够分了，再多用户看不过来） */
const MAX_OPTIONS = 4
const MAX_QUESTION_CHARS = 200
const MAX_LABEL_CHARS = 60
const MAX_EFFECT_CHARS = 200

/** 连续跳过几次就静音（用户连拒两次说明不想被打扰，第三次还问是骚扰） */
const SKIP_LIMIT = 2

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
   跳过计数（同一对话，纯内存）
   ══════════════════════════════════════════════════════════════ */

/** sessionId → 连续跳过的次数 */
const skips = new Map()

/** 用户跳过一次 */
function noteSkip(sessionId) {
  const key = String(sessionId ?? '')
  if (!key) return 0
  const next = (skips.get(key) ?? 0) + 1
  skips.set(key, next)
  return next
}

/**
 * 用户答过一次（哪怕只答了一问）→ 计数清零。
 * 答了说明他愿意被问，之前的跳过不再算数。
 */
function noteAnswered(sessionId) {
  skips.delete(String(sessionId ?? ''))
}

/** 这个对话现在静音了吗 */
function muted(sessionId) {
  return (skips.get(String(sessionId ?? '')) ?? 0) >= SKIP_LIMIT
}

/**
 * 手动唤醒（「问我想清楚」按钮 / 用户说「你问我几个问题」）。
 *
 * 静音是「别老问了」，不是「永远别问」——用户主动要求的时候要能立刻恢复。
 * 唤醒是**一次性**的：问完这一次，如果他再跳过，计数从头开始。
 */
function wake(sessionId) {
  const key = String(sessionId ?? '')
  if (key) skips.set(key, 0)
  return 0
}

/** 测试与排查用：看当前计数（自检要断言；生产代码不调它） */
function skipCount(sessionId) {
  return skips.get(String(sessionId ?? '')) ?? 0
}

/* ══════════════════════════════════════════════════════════════
   措辞：把结果翻成给模型看的一段话
   ══════════════════════════════════════════════════════════════ */

const TAIL_ON_SKIP =
  '用户跳过了这次澄清。按你自己判断最稳妥的做法开工，并在回复里用一行说明「我选了 X，因为 Y」。'

/**
 * @param {Array} questions `normalize()` 的输出
 * @param {{ answers?: Array<{question: string, choice?: string, text?: string}>, skipped?: boolean,
 *           timeout?: boolean }} reply
 */
function render(questions, reply = {}) {
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

  const lines = reply.timeout === true
    ? ['用户离场了，这次按**默认选项**继续（下面每条都标了是默认还是他选的）：']
    : ['用户的答复：']

  questions.forEach((item, index) => {
    const answer = byQuestion.get(item.question)
    const choice = text(answer?.choice, MAX_LABEL_CHARS) || item.defaultValue
    const chosen = item.options.find((one) => one.label === choice)
    const free = text(answer?.text, 400)
    const why = chosen?.effect ? `（因为：${chosen.effect}）` : ''
    const tag = reply.timeout === true && choice === item.defaultValue ? '［默认］' : ''
    lines.push(`${index + 1}. ${item.question} → ${tag}${choice}${why}`)
    if (free) lines.push(`   他还补充：${free}`)
  })

  if (reply.timeout !== true) {
    lines.push('', '按这些答复开工。答复里没提到的部分，你自己判断，别再来回问。')
  }
  return lines.join('\n')
}

module.exports = {
  MAX_QUESTIONS,
  MAX_OPTIONS,
  SKIP_LIMIT,
  TAIL_ON_SKIP,
  normalize,
  noteSkip,
  noteAnswered,
  muted,
  wake,
  skipCount,
  render,
  concrete,
}
