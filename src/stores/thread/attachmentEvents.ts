import type { Message } from '@/types'
import { uid } from '@/lib/utils'
import { useAppStore } from '../useAppStore'

/* ══════════════════════════════════════════════════════════════
   长消息落文件 → 界面上留一行**看得见**的提示（2026-10-04）

   内核在发出去之前把超长消息写成文件（`electron/core/long-paste.cjs`），
   发给模型的是「开头 + 路径」。这里负责把这件事**说出来**：

     · 用户贴的那条消息的气泡**一个字都不改**（仍是完整原文）；
     · 紧随其后插一行系统提示，写明「完整内容在哪、模型收到的是什么」。

   为什么不改气泡本身：气泡是用户自己贴的东西，替换成「摘要 + 路径」等于悄悄改他的内容；
   而需求里也明确要求气泡保持完整原文。所以提示做成**消息流里的一行** ——
   和「已压缩前 N 条对话」那个压缩点是同一个模式（`thread/compact.ts` 的 `compactMarker`）。

   幂等：同一份文件在这一轮里只提示一次（后续轮次内核不会重复发事件，这里再兜一层）。
   ══════════════════════════════════════════════════════════════ */

/** 提示文案（单独抽出来是为了能直接测，也方便将来改措辞） */
export function attachmentNotice(event: Record<string, unknown>): string {
  const file = String(event.path ?? '')
  const chars = Number(event.chars ?? 0)
  const kept = Number(event.kept ?? 0)
  return (
    `长消息（${chars} 字符）已存为 ${file}。` +
    `上面那条气泡仍是完整原文；发给模型的是开头 ${kept} 字符 + 这个路径，` +
    `需要全文（数行数、找某一段）它会自己用 read_file 读。`
  )
}

export function handleAttachmentEvent(threadId: string, event: Record<string, unknown>): void {
  const file = String(event.path ?? '')
  if (!threadId || !file) return
  const app = useAppStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return
  /* 同一份文件只提示一次（重开会话后已有这行就不再插） */
  const already = thread.messages.some((m) => m.role === 'system' && m.content.includes(file))
  if (already) return

  const marker: Message = {
    id: uid('msg'),
    threadId,
    role: 'system',
    content: attachmentNotice(event),
    kind: 'text',
    status: 'sent',
    timestamp: Date.now(),
  }
  app.addMessage(threadId, marker)
  /* 落盘（key 用这条提示自己的 id）；重开会话时这行也在 —— 路径不会丢 */
  app.persistMessage(threadId, {
    role: 'system',
    key: marker.id,
    content: marker.content,
    ts: marker.timestamp,
  })
}
