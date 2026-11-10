/** Bounded text context only. Images stay on the existing image preparation path. */
function historyContext(history, limit = 12000) {
  const blocks = []
  let remaining = limit
  for (const message of [...(history ?? [])].slice(-8).reverse()) {
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part) => part?.type === 'text')
              .map((part) => part.text)
              .join('\n')
          : ''
    if (!content.trim()) continue
    const text = content.slice(-Math.max(0, remaining - 32))
    blocks.unshift(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
    remaining -= text.length + 32
    if (remaining <= 32) {
      blocks.unshift('（更早内容超出本次交接预算，需使用已有记录核对）')
      break
    }
  }
  return blocks.join('\n\n')
}

module.exports = { historyContext }
