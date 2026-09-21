import type { Message } from '@/types'

/**
 * 把会话里的消息拼成「喂给主进程」的历史。
 *
 * 从 turns.ts 抽出来的（那边贴到 300 行上限了），顺便让它变成纯函数 —— 这段逻辑
 * 以前埋在发送流程中间，测不到。两条容易踩的规则都在这里：
 *
 * ① **带图的消息要换多模态格式**。漏了这步模型只会收到文字，然后回你
 *    「没收到图片」。
 * ② **助手消息要带上工具执行记录**。不带的话，模型看不到自己刚才干过什么。
 *
 * system 一并过滤掉 —— 系统提示由主进程自己拼，别重复发一份。
 */
export function buildHistory(messages: Message[], exceptMessageId: string) {
  return messages
    .filter((m) => m.id !== exceptMessageId && m.role !== 'system')
    .map((m) => {
      if (m.role === 'user' && m.images && m.images.length > 0) {
        return {
          role: m.role,
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
          ],
        }
      }
      return {
        role: m.role,
        content:
          m.role === 'assistant' && m.toolRuns?.length
            ? `${m.content}\n\n[此前工具执行记录]\n${m.toolRuns
                .map(
                  (tool) =>
                    `- ${tool.name}: ${tool.ok ? '成功' : '失败'}${tool.output ? `\n  ${tool.output.slice(0, 2000)}` : ''}`,
                )
                .join('\n')}`
            : m.content,
      }
    })
}
