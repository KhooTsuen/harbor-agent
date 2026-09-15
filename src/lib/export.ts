import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   导出

   线程 → Markdown。纯函数，不碰 DOM，方便单测。
   ══════════════════════════════════════════════════════════════ */

function escapeMarkdown(text: string): string {
  return text.replace(/```/g, '````').replace(/\n/g, '\n\n')
}

function messageBlock(message: Message): string {
  if (message.role === 'user') {
    return `### 你\n\n${message.content}\n`
  }

  if (message.role === 'system') {
    return `> ${message.content}\n`
  }

  /* 助手回复的小标题。用中性名字，导出文件里不该出现别的产品名 */
  const parts: string[] = [`### Agent\n`]

  if (message.reasoning) {
    parts.push(
      `<details>\n<summary>思考过程</summary>\n\n${escapeMarkdown(message.reasoning)}\n</details>\n`,
    )
  }

  if (message.toolRuns && message.toolRuns.length > 0) {
    parts.push(`**工具调用**\n`)
    for (const run of message.toolRuns) {
      parts.push(
        `- \`${run.name}\` ${run.ok ? '✓' : '✗'}${run.ms !== undefined ? ` (${run.ms}ms)` : ''}`,
      )
    }
    parts.push('')
  }

  parts.push(message.content || '', '')

  for (const block of message.codeBlocks ?? []) {
    parts.push(`\`\`\`${block.language}\n${block.code}\n\`\`\`\n`)
  }

  return parts.join('\n')
}

export function threadToMarkdown(thread: Thread): string {
  const lines: string[] = []
  lines.push(`# ${thread.title}`, '')

  const meta = [
    `- 模式：${thread.mode}`,
    `- 模型：${thread.model}`,
    `- 消息数：${thread.messages.length}`,
    `- 创建：${new Date(thread.createdAt).toLocaleString('zh-CN')}`,
  ]
  if (thread.tags.length > 0) meta.push(`- 标签：${thread.tags.join(', ')}`)
  lines.push(meta.join('\n'), '', '---', '')

  for (const message of thread.messages) {
    lines.push(messageBlock(message), '---', '')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
