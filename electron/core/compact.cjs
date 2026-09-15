/**
 * 上下文压缩
 *
 * 长对话必须压缩，否则上下文会一直堆到爆。
 * 做法：把较早的对话喂给模型生成摘要，之后只带「摘要 + 最近若干条」。
 *
 * 为什么不由后端自动触发：压缩是**有代价**的（多一次模型调用、而且摘要会丢细节），
 * 什么时候压应该让用户看得见。所以这里只提供能力，触发在前端 ——
 * 到阈值时前端会提示，用户也可以手动压。
 */

const llm = require('./llm.cjs')
const log = require('./log.cjs')

/**
 * 摘要提示词。
 *
 * 关键是把「必须留住什么」写清楚 —— 编程对话里最容易在摘要中丢失的是
 * **文件路径、函数名、已经做过的决定**，这些丢了模型会重复问或者重复改。
 */
const SUMMARY_SYSTEM = `你的任务是把一段编程对话压缩成简洁摘要，供后续对话当作背景使用。

必须严格按下面结构输出：
## Goal
用户想达成什么（原始诉求）
## Decisions
已经做出的技术决定及原因
## Constraints
用户明确表达的偏好、权限和边界
## Files Changed
已经修改过的文件及结果
## Tests
已经执行的测试和结果
## Unresolved Problems
还没解决的问题、风险、待办
## Next Step
下一步应该做什么

如果某一栏没有内容，写「无」。绝不编造没出现过的东西。

可以丢掉：
- 寒暄和确认性对话
- 已经推翻的中间方案
- 重复的解释

要求：
- 用简体中文，条目式，控制在 400 字以内
- 不要写「用户说 / 助手说」这种对话格式，直接写结论
- 不要编造没出现过的东西`

/**
 * 给一段对话生成摘要。
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} [options.chatPath]
 * @param {string} options.model
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} 摘要文本
 */
async function summarize(options) {
  const { messages, signal } = options

  /* 只取 user / assistant 的文本，工具调用记录不进摘要 */
  const transcript = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
    .join('\n\n')

  if (!transcript.trim()) throw new Error('这段对话没有可压缩的内容')

  const result = await llm.chatStream({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    chatPath: options.chatPath,
    model: options.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `请压缩下面这段对话：\n\n${transcript}` },
    ],
    temperature: 0.3,
    maxTokens: 1200,
    signal,
  })

  const summary = result.content.trim()
  if (!summary) throw new Error('模型没有返回摘要')

  log.info(`生成摘要 ${summary.length} 字（覆盖 ${messages.length} 条消息）`)
  return summary
}

/* ══════════════════════════════════════════════════════════════
   什么时候该压缩
   ══════════════════════════════════════════════════════════════ */

/**
 * 粗略估算 token 数。
 *
 * 不引入 tokenizer：那要下载几 MB 的词表，而且不同模型的分词还不一样。
 * 经验值：中文约 1.5 字/token，英文约 4 字符/token，
 * 混着算取 chars / 3 偏保守（宁可早压，不要到上限才压）。
 */
function estimateTokens(text) {
  return Math.ceil(String(text).length / 3)
}

/** 一次请求大概会占多少 token（历史 + 系统提示的粗估） */
function estimateHistoryTokens(messages) {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content ?? '') + 4 /* 每条消息的格式开销 */
  }
  return total
}

/** 是否该压：历史 token 超过模型上限的这个比例 */
const COMPACT_RATIO = 0.6

function shouldCompact(messages, maxTokens) {
  const used = estimateHistoryTokens(messages)
  const limit = Math.max(2000, Math.floor((maxTokens || 4096) * COMPACT_RATIO))
  return { needed: used > limit, used, limit }
}

module.exports = { summarize, estimateTokens, estimateHistoryTokens, shouldCompact, COMPACT_RATIO }
