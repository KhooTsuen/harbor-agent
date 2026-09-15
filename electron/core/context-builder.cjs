/** CE-003：统一 Context Builder。
 * 预算以字符估算，优先保留当前任务、状态和近期消息；超长工具结果截断。
 */
const DEFAULT_BUDGET = {
  system: 10,
  memory: 5,
  project: 15,
  task: 10,
  conversation: 30,
  tools: 20,
  reserve: 10,
}
function chars(value) {
  return typeof value === 'string' ? value.length : 0
}
function trim(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 40))}\n[…上下文已按预算裁剪…]`
}
function messageText(message) {
  return typeof message?.content === 'string'
    ? message.content
    : JSON.stringify(message?.content ?? '')
}
function assemble(input = {}) {
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
    const copy = { ...item, content: trim(messageText(item), remaining) }
    const size = chars(copy.content)
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
