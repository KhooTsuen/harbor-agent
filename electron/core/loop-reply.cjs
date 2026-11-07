/**
 * 收尾前的一次续写（从 `loop.cjs` 拆出来的 —— 那边贴 300 行红线）
 *
 * 判据与「续写为什么不带工具」全在 `reply-continue.cjs` 的文件头，
 * 这里只做一件 `loop.cjs` 不该操心的事：**把续写用掉的那点 token 并回总账**。
 *
 * 为什么 usage 要绕一圈拿返回值而不是直接改 `totalUsage`：
 * `loop.cjs` 的 `totalUsage` 是局部变量，闭包里改它看着简单，但会让
 * 「这一轮到底烧了多少」变成两处写（原调用处 + 续写处），
 * 以后加第三个调用点就会漏。所以统一走返回值，`loop.cjs` 里 merge 一次。
 */
const replyContinue = require('./reply-continue.cjs')
const { mergeUsage } = require('./loop-model.cjs')

/**
 * @param {{ result: object, messages: Array<object>, emit?: Function, callModel: Function,
 *           transcript: { mergeRound: () => void }, baseArgs: object }} input
 * @returns {Promise<{ added: string, text: string, cut: boolean, reason: string,
 *                     continued: number, usage: object|null }>}
 *   `usage` = 续写那几次调用报回来的用量（没截断时为 null）
 */
async function finishReply(input) {
  const { result, messages, emit, callModel, transcript, baseArgs } = input
  let usage = null

  const reply = await replyContinue.completeReply({
    result,
    messages,
    emit,
    callModel,
    /* 第一轮先并进总账 —— 续写那段才是「最后一轮终稿」（见 completeReply 的 added/text 说明） */
    mergeRound: () => transcript.mergeRound(),
    addUsage: (u) => {
      usage = u ? mergeUsage(usage, u) : usage
    },
    baseArgs,
  })

  return { ...reply, usage }
}

module.exports = { finishReply }
