/**
 * 对话 handler 用的两个纯工具
 *
 * 从 `chat.cjs` 拆出来的（那边 309 行贴了上限）。挑这两个搬是因为它们
 * **没有状态、不碰 IPC** —— 纯粹「history 这么长」「最后一句用户说了什么」，
 * 搬走零风险，也不用改调用方逻辑。
 *
 * `pendingConfirms`（等待用户点允许/拒绝的那张表）**没搬**：它是有状态的，
 * 和 send / confirm 两个 handler 一起才有意义。
 */

const config = require('../core/config.cjs')

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
    if (typeof message.content === 'string') return message.content.slice(0, 200)
    if (Array.isArray(message.content)) {
      const text = message.content.find((part) => part?.type === 'text')?.text
      if (typeof text === 'string') return text.slice(0, 200)
    }
  }
  return ''
}

module.exports = { currentHistoryLimit, lastUserText }
