/**
 * 上下文裁剪的**文本口径** —— 唯一一处实现
 *
 * ── 为什么单独一个文件（P1-A，2026-11-07）──────────────────────
 *
 * `assemble` 的「从尾部往前挑消息」搬到了 `context-groups.cjs`（那边按**消息组**挑，
 * 见该文件头）。两个文件都要回答同一件事：**这一条占多少预算、按额度怎么切**。
 * 各写一份就是两份迟早漂移的规则（硬约束 9），而且漂了不会有测试报红 ——
 * 症状是「预算明明一样，挑出来的条数却不同」。
 *
 * `context-builder.cjs` 仍然导出 `trim`（自检组与测试拿它当口径），只是正文在这里。
 *
 * ⚠️ 2026-09-28 真机事故（用户报「DeepSeek 都支持多模态了，它还说看不见图」）：
 * 这里以前对每条消息一律 `JSON.stringify(content)` 再按字符切。带图消息的 content
 * 是**多模态数组** —— 压成字符串再切，图片就只剩一段文件头。模型收到的是**坏图**，
 * 于是如实回答「画面数据没进来」。现在：**图片块整块保留，只切文本**。
 */
const { textOf, countImages } = require('./message-text.cjs')

/**
 * 一张图按多少字符占预算。
 *
 * **不能按 base64 的真实长度算**：一张 200KB 的图是 27 万字符，而 API 侧只按
 * 一千来个 token 计——照真长算的话，一张图就把整个对话预算挤没，消息全被丢掉。
 * 给个固定成本，保证「带图的那条」总排得进来，同时压住「一次塞五张图」的极端情况。
 */
const IMAGE_COST = 800

/**
 * 裁剪说明的**固定长度**（算预算时要预先留出来）。
 *
 * 带上了原长：模型（和事后看日志的人）能区分「这条本来就很短」和「它有两万字但只进来了开头」。
 * 尾部的 `…上下文已按预算裁剪…` 刻意保留原措辞 —— 历史文档、自检组（86-vision）与
 * 用户回的会话记录里都是这个串，换掉它等于把过去的证据链断掉。
 */
const TRIM_NOTE_RESERVE = 64
const trimNote = (len) => `\n[这条消息原有 ${len} 字符，只有开头进得来。…上下文已按预算裁剪…]`

function chars(value) {
  return typeof value === 'string' ? value.length : 0
}

function trim(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const note = trimNote(text.length)
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`
}

/** 切一条消息的内容：多模态**只切文本、图片整块留**（切一半的 base64 是坏图） */
function trimContent(content, limit) {
  if (!Array.isArray(content)) return trim(textOf(content), limit)
  const textLimit = Math.max(0, limit - countImages(content) * IMAGE_COST)
  return content
    .map((part) => {
      if (typeof part?.text !== 'string') return part
      /* 文本预算已被图片占满：整段丢掉。留半句话除了误导模型没别的作用 */
      if (textLimit <= 0) return null
      return { ...part, text: trim(part.text, textLimit) }
    })
    .filter((part) => part !== null)
}

/** 一条消息的正文占多少预算：文本按字符，图片按固定成本 */
function sizeOf(content) {
  if (!Array.isArray(content)) return chars(content)
  return chars(textOf(content)) + countImages(content) * IMAGE_COST
}

/** 每条消息的形状开销（role / 分隔符 / tool_call_id 这些上游也会计） */
const MESSAGE_OVERHEAD = 12
/** 每个工具调用的形状开销（id + type + name + arguments 的包装） */
const CALL_OVERHEAD = 24

/**
 * 一条消息占多少预算：**正文 + 工具调用的形状**。
 *
 * ★ 这一条就是 P1-A 的核心修正（2026-11-07）。以前 `assemble` 用 `sizeOf(content)`：
 *   模型只调工具、不说话时，那条 `assistant` 的 `content` 是空串 → 算出来 **0** →
 *   被判成「无意义消息」跳过 → 它后面那一串 `tool` 全部成了孤儿 → `completeToolGroups`
 *   把整组丢掉 → 用户 30 次工具调用的诊断结果**一条都进不了上下文**（实测 62 条 → 2 条）。
 *
 *   而 `tool_calls` 本身是要占上游预算的（id / 函数名 / 参数都在请求体里），
 *   所以「正文为空」不等于「这条消息没有内容」。
 *
 * @param {{ content?: unknown, tool_calls?: Array<object>, tool_call_id?: string }} message
 * @returns {number} 字符当量
 */
function sizeOfMessage(message) {
  const base = sizeOf(message?.content) + MESSAGE_OVERHEAD
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const callSize = calls.reduce(
    (sum, call) =>
      sum +
      chars(call?.id) +
      chars(call?.function?.name) +
      chars(call?.function?.arguments) +
      CALL_OVERHEAD,
    0,
  )
  return base + callSize + chars(message?.tool_call_id)
}

/** 按额度切一条消息的**正文**；`tool_calls` / `tool_call_id` 原样保留（协议不能动） */
function trimMessage(message, limit) {
  return { ...message, content: trimContent(message?.content, limit) }
}

module.exports = {
  IMAGE_COST,
  TRIM_NOTE_RESERVE,
  MESSAGE_OVERHEAD,
  CALL_OVERHEAD,
  chars,
  trim,
  trimContent,
  sizeOf,
  sizeOfMessage,
  trimMessage,
}
