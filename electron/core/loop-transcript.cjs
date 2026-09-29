/**
 * 逐轮累积「这一轮说了什么」（时间线第二步）
 *
 * 一轮对话 = 若干回合（调模型 → 工具 → 再调 …）。内核以前只把**最后一轮**的
 * 正文与思考回给渲染层，于是这些都只剩最后一段：
 *
 *   · 复制整条回答 / 导出 / 搜索
 *   · **下一轮喂回模型的历史**（`buildHistory` 读的就是消息的 content）
 *
 * 中间那些轮说了什么，只有界面上的时间线（`rounds`）记得 —— 但它只活在渲染进程里，
 * 进程一结束就没了（真机量的：一条 124 次工具调用的回复，思考 3213 字、
 * 正文 3971 字，界面上一轮一轮排得好好的，落盘的消息级字段却只剩尾巴）。
 *
 * 提前结束的那几条路（暂停 / 撞预算 / 轮数到顶）以前更狠：正文被那句提示
 * **整个替换掉** —— 用户看不到模型已经说过的任何一句话。所以这里给了
 * `withNotice()`：把提示**接在已说的话后面**。
 */

function createTranscript() {
  /** 已经收尾的那些轮 */
  const said = []
  const thought = []
  /** 正在攒的这一轮 */
  let roundSaid = ''
  let roundThought = ''

  /** 最后一轮的终稿：不传（或传空）就用这一轮攒的原文 */
  const lastText = (tail) => String(tail ?? '').trim() || roundSaid.trim()

  const join = (list) => list.filter(Boolean).join('\n\n')

  return {
    /**
     * 包一对回调给 `callModel`：边累积边发。
     *
     * 为什么包在这里而不是在 loop.cjs 里写两行：那边贴着 300 行红线，
     * 两个回调从各一行变成各四行就超了。
     */
    stream(emit) {
      return {
        content(text) {
          roundSaid += text
          emit({ type: 'content', text })
        },
        reasoning(text) {
          roundThought += text
          emit({ type: 'reasoning', text })
        },
      }
    },
    /** 这一轮结束（还要接着调工具）：并进总账，下一轮从零开始攒 */
    mergeRound() {
      if (roundSaid.trim()) said.push(roundSaid.trim())
      if (roundThought.trim()) thought.push(roundThought.trim())
      roundSaid = ''
      roundThought = ''
    },
    /** 到这一步为止说了什么（`tail` 传最后一轮的终稿 —— 自检复核可能改写它） */
    soFar(tail) {
      return {
        content: join([...said, lastText(tail)]),
        reasoning: join([...thought, roundThought.trim()]),
      }
    },
    /** 提前结束：把提示接在已说的话后面，别把正文换掉 */
    withNotice(notice) {
      return {
        content: join([...said, lastText(), notice]),
        reasoning: join([...thought, roundThought.trim()]),
      }
    },
  }
}

module.exports = { createTranscript }
