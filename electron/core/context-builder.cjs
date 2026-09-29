/** CE-003：统一 Context Builder。
 * 预算以字符估算，优先保留当前任务、状态和近期消息；超长工具结果截断。
 *
 * ⚠️ 2026-09-28 真机事故（用户报「DeepSeek 都支持多模态了，它还说看不见图」）：
 * 这里以前对每条消息一律 `JSON.stringify(content)` 再按字符切。带图消息的 content
 * 是**多模态数组** ——
 *   `[{type:'text',text:'这是什么'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBOR…'}}]`
 * 压成字符串再切，图片就只剩一段文件头。模型收到的是**坏图**，
 * 于是如实回答「画面数据没进来」。现在：**图片块整块保留，只切文本**。
 */
const { textOf, countImages } = require('./message-text.cjs')

const DEFAULT_BUDGET = {
  system: 10,
  memory: 5,
  project: 15,
  task: 10,
  conversation: 30,
  tools: 20,
  reserve: 10,
}

/**
 * 一张图按多少字符占预算。
 *
 * **不能按 base64 的真实长度算**：一张 200KB 的图是 27 万字符，而 API 侧只按
 * 一千来个 token 计——照真长算的话，一张图就把整个对话预算挤没，消息全被丢掉。
 * 给个固定成本，保证「带图的那条」总排得进来，同时压住「一次塞五张图」的极端情况。
 */
const IMAGE_COST = 800

function chars(value) {
  return typeof value === 'string' ? value.length : 0
}
function trim(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 40))}\n[…上下文已按预算裁剪…]`
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

/** 一条消息占多少预算：文本按字符，图片按固定成本 */
function sizeOf(content) {
  if (!Array.isArray(content)) return chars(content)
  return chars(textOf(content)) + countImages(content) * IMAGE_COST
}
function assemble(input = {}) {
  /*
   * ★ 这里的 `maxTokens` 是**上下文预算的基准**（字符 = token × 3），不是「输出上限」——
   *   虽然调用方传的就是设置里的 `assistant.maxTokens`（历史耦合，2026-09-29 没拆）。
   *   两件事混在一起的真实后果：用户把「输出上限」改大，上下文也会跟着变宽。
   *   0 = 不限（新的默认）→ 退回 4096，也就是和以前一样。
   */
  const maxTokens = Math.max(2000, Number(input.maxTokens) || 4096)
  const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}) }
  const totalChars = maxTokens * 3
  const cap = (name) => Math.max(400, Math.floor(totalChars * (Number(budget[name] ?? 10) / 100)))
  const state = trim(input.conversationState, cap('task'))
  const memory = trim(input.memory, cap('memory'))
  const project = trim(input.project, cap('project'))
  const task = trim(input.task, cap('task'))
  const recent = Array.isArray(input.messages) ? input.messages : []
  let remaining = cap('conversation')
  const selected = []
  for (let i = recent.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const item = recent[i]
    const copy = { ...item, content: trimContent(item.content, remaining) }
    const size = sizeOf(copy.content)
    if (size > 0) {
      selected.unshift(copy)
      remaining -= size
    }
  }
  return {
    systemContext: { memory, project, task, conversationState: state },
    messages: selected,
    estimates: { maxTokens, chars: totalChars - remaining, selectedMessages: selected.length },
  }
}
module.exports = { DEFAULT_BUDGET, assemble, trim }
