/**
 * 对话 handler 用的几个纯工具
 *
 * 从 `chat.cjs` 拆出来的（那边 309 行贴了上限）。挑这些搬是因为它们
 * **没有状态、不碰 IPC** —— 纯粹「history 这么长」「最后一句用户说了什么」
 * 「按轮次切一刀」，搬走零风险，也不用改调用方逻辑。
 *
 * 「等待用户点允许/拒绝」那张表**没搬**（也不在 `chat.cjs` 里了）：AG-053 之后它
 * 住在 `core/confirm-bridge.cjs`（连超时、两条往返共用），`chat.cjs` 只调它。
 */

const config = require('../core/config.cjs')
/* 文本口径（含带图消息的多模态数组）只有一处实现：message-text.cjs */
const { textOf } = require('../core/message-text.cjs')
/* P0-1：按完整轮次截取 —— 切轮次与「省了哪轮」的说法都在那边（唯一一处） */
const { takeTurns, describeWindow } = require('../core/history-window.cjs')

/** 会话注入给模型的历史条数上限（设置里可调，夹在 0–200） */
function currentHistoryLimit() {
  const value = Number(config.get().assistant.historyLimit)
  return Number.isFinite(value) ? Math.max(0, Math.min(200, Math.floor(value))) : 20
}

/**
 * history 里最后一条用户消息的文字 —— 当作任务目标（任务标题）。
 * 内容可能是字符串，也可能是多模态数组（带图时），两种都认。
 */
function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message?.role !== 'user') continue
    const text = textOf(message.content)
    if (text) return text.slice(0, 200)
  }
  return ''
}

/**
 * 按**完整轮次**截取历史（P0-1，2026-10-23）。
 *
 * `rawHistory` 已经把工具记录展开成了 `assistant(tool_calls)` + `tool`
 * （见 `src/stores/thread/history.ts`），所以直接 `slice(-limit)` 会把一组工具调用
 * 切成两半：带 `tool_calls` 的 assistant 进来、对应的 `tool` 被切掉，上游 400
 * 「tool_call_id 无对应」。用户的原话：「30 次工具调用之后发送『那个地方接着改』，
 * 最终请求里只剩这一句」。
 *
 * 切点只落在轮次边界，预算仍按条数算 —— 设置里 historyLimit 的口径不变。
 *
 * @returns {{ history: Array<object>, omitted: string, lossy: Array<object> }}
 *          `omitted` = 「省了哪轮」的说明；`lossy` = 用户原话真的没进请求的逐条明细
 *          （空数组 = 无损）—— 发送入口拿它做程序级判断（`core/fold-gate.cjs`）
 */
function windowHistory(rawHistory, limit = currentHistoryLimit()) {
  const windowed = takeTurns(rawHistory, limit, { minTurns: 1 })
  return {
    history: windowed.kept,
    omitted: describeWindow(windowed, rawHistory),
    lossy: Array.isArray(windowed.lossy) ? windowed.lossy : [],
  }
}

module.exports = { currentHistoryLimit, lastUserText, windowHistory }
