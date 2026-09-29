/**
 * 循环的**返回值构造**（正常收尾之外的几条路）
 *
 * 从 `loop-model.cjs` 搬出来的 —— 那边加了「逐轮累积」之后到了 312 行。
 * 切法是按职责：`loop-model` 管「怎么调模型、怎么复核」，
 * 这里只管「停下来时回给调用方什么形状」。
 *
 * ⚠️ 两条路的 `content` 都是**提示 + 已经说过的话**：
 * 以前 `content` 被写成**那句提示本身**，模型说过的一整段正文就被抹掉了 ——
 * 用户只看到「任务已暂停」四个字，以为自己白等了。
 */

const loopGuard = require('./loop-guard.cjs')

/**
 * AG-011：暂停时的返回值。
 *
 * 故意和正常返回**同形**，只多一个 `paused: true` —— 调用方（loop.run）
 * 拿它决定把任务台账标成 paused 还是 completed，别处不用改。
 */
function pausedResult({ turn, usage, toolRuns, transcript = null }) {
  const notice = '（任务已暂停，可以从这里继续）'
  const said = transcript?.withNotice(notice) ?? { content: notice, reasoning: '' }
  return {
    content: said.content,
    reasoning: said.reasoning,
    usage,
    turns: turn,
    toolRuns,
    paused: true,
  }
}

/** AG-011：轮数用尽时的返回值（活没干完，同样可恢复） */
function exhaustedResult({
  usage,
  toolRuns,
  maxTurns,
  budgetHit = null,
  loopHit = null,
  transcript = null,
}) {
  const text = (() => {
    if (budgetHit) {
      return `${budgetHit.message}
（停下来等你决定：继续 / 停止 / 调整预算。）`
    }
    if (loopHit) {
      /* 文案住在 loop-guard.cjs（和「对模型说的」那句挨着），这边只负责挑一句 */
      return loopGuard.stopMessage(loopHit)
    }
    return `（已经连续调用工具 ${maxTurns} 轮，先停在这里。你可以说「继续」让我接着做。）`
  })()
  const said = transcript?.withNotice(text) ?? { content: text, reasoning: '' }
  return {
    content: said.content,
    reasoning: said.reasoning,
    usage,
    turns: maxTurns,
    toolRuns,
    exhausted: true,
    budgetHit,
    loopHit,
  }
}

module.exports = { pausedResult, exhaustedResult }
