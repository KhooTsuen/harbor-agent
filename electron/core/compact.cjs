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

const log = require('./log.cjs')
/*
 * 分块实现整体在 compact-chunked.cjs（那份文件管「怎么切、怎么迭代」）。
 * ★ 发请求、估算 token、块大小常量**都从那边来** —— 本文件不留第二份
 *   （同一个公式写两遍，改一处忘另一处，压缩口径就会前后不一致）。
 */
const chunked = require('./compact-chunked.cjs')

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
 * ★ 2026-10-20 起支持**分块**（修「压缩请求本身超限」，见 compact-chunked.cjs）：
 *   `maxInputTokens` 是这次可用的窗口。不给（或 0）就走老的单次路径 ——
 *   保持向后兼容，老调用方不传它也照旧能用。
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} [options.chatPath]
 * @param {string} options.model
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {number} [options.maxInputTokens] 窗口 token 数（不给 = 单次发，老行为）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} 摘要文本
 */
async function summarize(options) {
  const { messages } = options

  /* 只取 user / assistant 的文本，工具调用记录不进摘要 */
  const transcript = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
    .join('\n\n')

  if (!transcript.trim()) throw new Error('这段对话没有可压缩的内容')

  const windowTokens = Number(options.maxInputTokens) > 0 ? Number(options.maxInputTokens) : 0
  const total = chunked.estimateTokens(transcript)
  /* 放得下（或调用方没给窗口）就一次发 —— 老行为，也省掉分块开销 */
  const fits = !windowTokens || total <= chunked.CHUNK_TOKENS

  if (fits) {
    const summary = await chunked.askModel(options, SUMMARY_SYSTEM, [
      { role: 'user', content: `请压缩下面这段对话：\n\n${transcript}` },
    ])
    log.info(`生成摘要 ${summary.length} 字（覆盖 ${messages.length} 条消息，单次 ${total} token）`)
    return summary
  }

  return chunked.summarizeChunked({ ...options, transcript, windowTokens })
}

/**
 * 这个模型能吃多少 token —— **窗口解析的唯一一处**。
 *
 * 为什么单独抽出来（2026-10-20 真机逮到）：压缩有**两条入口**，
 *   · 用户手动压 → `handlers/compact.cjs`
 *   · 上下文超限自动压 → `loop-model.cjs` 的 `compactMessages()`
 * 修「压缩本身超限」时只改了前者，后者仍在整段发 —— 于是自动压缩照样 400。
 * 现在两边都从这里取，口径不可能再漂（硬约束 #9）。
 *
 * 拿不到（模型不认识 / 能力表没有）就返回 0 —— 调用方据此退回「整段发」的老路径，
 * 与之前行为一致，不因为查不到就把调用弄坏。
 *
 * @param {object} provider 供应商（要用它的 `modelCapabilities` 与后端种类）
 * @param {string} model 模型名
 * @returns {number} 窗口 token 数；0 = 查不到
 */
function windowOf(provider, model) {
  try {
    /* 延迟 require：本模块在压缩路径上被反复加载，顶层引入会拖慢启动 */
    const capsOf = require('./provider-capabilities.cjs')
    const caps = capsOf.resolve(String(model ?? ''), provider && provider.modelCapabilities, provider)
    const n = Number(caps && caps.caps && caps.caps.context_window)
    return n > 0 ? n : 0
  } catch {
    return 0
  }
}

/* ══════════════════════════════════════════════════════════════
   什么时候该压缩
   ══════════════════════════════════════════════════════════════ */

/**
 * 粗略估算 token 数 —— **直接复用 chunked 那一份**（同一个系数不能写两遍）。
 *
 * 不引入 tokenizer：那要下载几 MB 的词表，而且不同模型的分词还不一样。
 * 经验值：中文约 1.5 字/token，英文约 4 字符/token，
 * 混着算取 chars / 3 偏保守（宁可早压，不要到上限才压）。
 */
const estimateTokens = chunked.estimateTokens

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

/**
 * AG-016：用摘要替掉旧的对话，留下系统提示和最近几条。
 *
 * 保留尾巴是有意的：摘要一定会丢细节，而「刚刚发生的事」往往还要接着用
 * （刚读出来的文件内容、刚报的错、刚写的计划）。
 */
function rebuild(history, summary, keepTail = 6) {
  const list = Array.isArray(history) ? history : []
  const system = list.filter((m) => m.role === 'system')
  const rest = list.filter((m) => m.role !== 'system')
  /*
   * 冻结摘要的**版本关系**（token 优化）：不原地重写，每次压缩新增一个带版本号的块。
   * 旧格式（无版本号）也认 —— 计数不依赖格式。
   */
  const prior = list.filter(
    (m) => m.role === 'user' && /^【之前对话的摘要/.test(String(m.content ?? '')),
  ).length
  const version = prior + 1
  return [
    ...system,
    { role: 'user', content: `【之前对话的摘要 v${version}】\n${summary}` },
    ...rest.slice(-keepTail),
  ]
}

function shouldCompact(messages, maxTokens) {
  const used = estimateHistoryTokens(messages)
  const limit = Math.max(2000, Math.floor((maxTokens || 4096) * COMPACT_RATIO))
  return { needed: used > limit, used, limit }
}

module.exports = {
  summarize,
  windowOf,
  rebuild,
  estimateTokens,
  estimateHistoryTokens,
  shouldCompact,
  COMPACT_RATIO,
}
