import type { Message, Thread } from '@/types'
import { processHeaderText, formatDuration } from '@/lib/processSummary'

/* ══════════════════════════════════════════════════════════════
   导出 / 复制完整记录

   线程 → Markdown。纯函数，不碰 DOM，方便单测。

   ── ★ 2026-10-21：一份实现，两个出口 ─────────────────────────
   界面上的「复制完整记录」和「导出到 .md」是**同一份过程区**——
   各写一套的话，将来改一处（比如给工具行加失败原因）另一处就悄悄漂开。
   所以过程区在 `processSection()`，两边都调它。

   ── 内容归属（与界面同一套规矩）──────────────────────────────
   · **过程**（思考 / 工具）= 折叠区里的东西，导出也折叠（`<details>`）
   · **正文**（`content`）= 阅读主体，原样放在折叠区**外面**
   · **状态**（用时 / 已中断 / 失败）写在过程区的标题上 —— 导出文件里
     丢掉「这条其实没写完」是最不能接受的一种失真。
   ══════════════════════════════════════════════════════════════ */

function escapeMarkdown(text: string): string {
  return text.replace(/```/g, '````').replace(/\n/g, '\n\n')
}

/**
 * 过程区（思考 + 逐条工具）—— **复制完整记录与导出共用这一份**。
 *
 * 没有任何过程时返回空串（纯问答不产出空的 `<details>` 块）。
 */
export function processSection(message: Message): string {
  const runs = message.toolRuns ?? []
  const hasProcess = Boolean(message.reasoning?.trim()) || runs.length > 0
  if (!hasProcess) return ''

  /*
   * 入口那一行只回答「收的是什么、多少步」（与界面同一份文案）。
   * ★ 用时放在 `<details>` **里面**第一行 —— 与界面展开区一致：
   *   入口不再承担秒数，但「跑了多久」这件事不能丢（否则导出文件里查不出耗时）。
   */
  const head = processHeaderText(
    {
      durationMs: message.durationMs,
      interrupted: message.interrupted,
      failed: message.status === 'error',
    },
    runs,
  )
  const parts: string[] = [`<details>\n<summary>过程 · ${head}</summary>\n`]

  if (!message.interrupted && typeof message.durationMs === 'number' && message.durationMs > 0) {
    parts.push(`用时 ${formatDuration(message.durationMs)}\n`)
  }

  if (message.reasoning?.trim()) {
    parts.push(`**思考**\n\n${escapeMarkdown(message.reasoning)}\n`)
  }

  if (runs.length > 0) {
    parts.push(`**工具调用**\n`)
    for (const run of runs) {
      parts.push(
        `- \`${run.name}\` ${run.ok ? '✓' : '✗'}${run.ms !== undefined ? ` (${run.ms}ms)` : ''}`,
      )
      /* 失败的要带上原因 —— 只画一个 ✗ 等于把「为什么失败」丢了 */
      if (!run.ok && run.output.trim()) parts.push(`  - 原因：${run.output.trim().slice(0, 500)}`)
    }
    parts.push('')
  }

  parts.push('</details>\n')
  return parts.join('\n')
}

/**
 * 一条消息的**完整记录**（过程 + 正文 + 状态）。
 *
 * 剪贴板「复制完整记录」用它；导出也用它（`messageBlock` 里的助手分支）。
 * 默认复制走的是 `message.content`（只要正文），不调这里。
 */
export function fullRecordText(message: Message): string {
  const parts: string[] = []

  if (message.role !== 'assistant') {
    return message.role === 'user' ? message.content : `> ${message.content}`
  }

  const process = processSection(message)
  if (process) parts.push(process)

  parts.push(message.content || '')

  for (const block of message.codeBlocks ?? []) {
    parts.push(`\`\`\`${block.language}\n${block.code}\n\`\`\`\n`)
  }

  /* 未完成 / 出错 —— 导出文件里也必须留着，不然读的人以为这就是全篇 */
  if (message.interrupted) parts.push('> 这条回复没写完 —— 上次运行被打断了。')
  else if (message.status === 'error') parts.push('> 这次没能完成，上面是已完成的部分。')

  return parts.filter(Boolean).join('\n\n')
}

function messageBlock(message: Message): string {
  if (message.role === 'user') {
    return `### 你\n\n${message.content}\n`
  }

  if (message.role === 'system') {
    return `> ${message.content}\n`
  }

  /* 助手回复的小标题。用中性名字，导出文件里不该出现别的产品名 */
  return `### Agent\n\n${fullRecordText(message)}\n`
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
