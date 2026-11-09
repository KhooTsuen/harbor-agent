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
const summaryPhase = require('./summary-phase.cjs')
const handoff = require('./summary-handoff.cjs')
const { mergeUsage } = require('./loop-model.cjs')
const taskCore = require('./task.cjs')

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

/**
 * 收尾：**要不要开独立总结对话**。
 *
 * 只有工具执行后缺少交付正文，才调用独立汇报作为答复。
 * 纯聊天不开 —— 那种情况下「最后一段话」本来就是回答本身，再让它自己总结一遍
 * 只会多一次请求、多一份重复内容。
 *
 * ★ 这条判据**只回答「要不要开总结」**，不回答「任务做成没」。
 *   成没成由 `summary-handoff.verdictOf` 按台账证据判（失败项 / 计划 / 测试退出码），
 *   结果放在 `verdict` 里**与正文一起**带出去（界面要能同时说「答完了」和「但有失败项」）。
 *
 * @returns {Promise<{ content: string, finalContent: string, truncated: string, usage: object|null, verdict: string }>}
 */
async function finishTurn(input) {
  const { toolRuns = [], taskId = '', goal = '', ...rest } = input

  if (!summaryPhase.wantSummary({ toolRuns })) {
    const reply = await finishReply(rest)
    return {
      content: rest.transcript.soFar(reply.added || rest.result.content).content,
      finalContent: reply.text,
      truncated: reply.cut ? String(reply.reason ?? '') : '',
      usage: reply.usage,
      /* 纯聊天没执行工具 → 没有「验收」这回事。写 'chat' 而不是编一个 done，
         免得界面把「聊天答完了」说成「任务验收通过」。 */
      verdict: 'chat',
    }
  }

  const task = taskId ? taskCore.get(taskId) : null
  const built = handoff.buildHandoff({ task, toolRuns, goal })
  if (String(rest.result.content ?? '').trim()) {
    const reply = await finishReply(rest)
    return {
      content: rest.transcript.soFar(reply.added || rest.result.content).content,
      finalContent: reply.text,
      truncated: reply.cut ? String(reply.reason ?? '') : '',
      usage: reply.usage,
      verdict: built.verdict,
    }
  }
  rest.transcript.mergeRound()
  const sum = await summaryPhase.runSummary({
    handoff: built,
    baseArgs: rest.baseArgs,
    callModel: rest.callModel,
    emit: rest.emit,
  })
  /*
   * ★ 两样东西必须分开带出去（2026-11-09）：
   *   · `content` —— **面向用户的答复文字**（总结对话写的那一段）
   *   · `verdict` —— **验收结论**（按台账证据判的 done / partial / failed）
   *
   * 以前只有 content 往下传，verdict 停在主进程里 —— 于是界面看到一段
   * 「都做完了」的文字，却不知道台账里其实还有失败项。答复和验收是两件事，
   * 结论得单独带着，界面才能同时说出来（「答复已结算，任务仍未完成」是允许的）。
   */
  return { content: sum.text, finalContent: sum.text, truncated: sum.truncated, usage: sum.usage, verdict: built.verdict }
}

module.exports = { finishReply, finishTurn }
