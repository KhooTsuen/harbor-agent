import type { ClipboardEvent } from 'react'
import type { Message } from '@/types'
import { looksLikeImage } from '@/lib/imageFormat'
import { normalizeDataUrl, normalizeImage } from '@/lib/imageNormalize'
import { uid } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   Composer 的附件操作

   四类：贴图、选图、附加文件（任何格式）、把生成的图片插进对话。
   从 Composer 拆出来的 —— 那边贴着 300 行，而这些逻辑
   和「输入框长什么样」是两回事。

   ★ 贴图 / 选图都要过 `lib/imageNormalize`（2026-09-28 真机报错的修复）：
     Windows 剪贴板的截图**经常是 BMP**，而选图那条路也允许 .bmp ——
     原样发出去上游会直接 400（只收 webp/png/jpeg/gif）。现在不支持的格式
     转成 PNG、超长边（>2048）等比缩小，合规的原样透传。

   ★ 「附加文件」2026-10-08 起不再只吃文本：主进程按扩展名分流解析
     （PDF / Word / Excel / PPT / 压缩包 / 二进制，见 electron/core/file-extract.cjs），
     渲染层只负责把它挂成卡片（stores/thread/attachments.ts）。
   ══════════════════════════════════════════════════════════════ */

export interface ComposerAttachments {
  /** 加一张图（data URL）。粘贴和选文件都走这里 */
  attachImage: (dataUrl: string) => void
  /** 输入框粘贴：收下图就返回 true（调用点据此 preventDefault） */
  attachFromClipboard: (event: ClipboardEvent<HTMLTextAreaElement>) => boolean
  pickImage: () => Promise<void>
  /** 选文件（可多选），按格式解析后挂成附件卡片 */
  attachFiles: () => Promise<void>
  /** 把生成的图片作为一条消息插进当前对话 */
  insertImageMessage: (prompt: string, image: string) => void
}

export function useComposerAttachments(): ComposerAttachments {
  const addInputImage = useThreadStore((s) => s.addInputImage)
  const addInputFile = useThreadStore((s) => s.addInputFile)
  const showToast = useUIStore((s) => s.showToast)

  function attachImage(dataUrl: string): void {
    if (!dataUrl.startsWith('data:image/')) return
    addInputImage(dataUrl)
  }

  /** 归整好再加进去；转过了就告诉用户一声（静默转换会让人以为图被改坏了） */
  async function attachBlob(blob: Blob): Promise<void> {
    try {
      const { dataUrl, changed, reason } = await normalizeImage(blob)
      attachImage(dataUrl)
      if (changed) showToast('info', '图片已转换', reason)
    } catch (error) {
      showToast('error', '这张图用不了', error instanceof Error ? error.message : String(error))
    }
  }

  function attachFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    const files = Array.from(event.clipboardData?.files ?? []).filter(looksLikeImage)
    if (files.length === 0) return false
    for (const file of files) void attachBlob(file)
    return true
  }

  async function pickImage(): Promise<void> {
    const picked = await window.workbench?.pickImageAsDataUrl()
    if (!picked || picked.canceled) return
    if (!picked.ok || !picked.dataUrl) {
      showToast('error', '读图失败', picked.error)
      return
    }
    try {
      const { dataUrl, changed, reason } = await normalizeDataUrl(picked.dataUrl)
      attachImage(dataUrl)
      if (changed) showToast('info', '图片已转换', reason)
    } catch (error) {
      showToast('error', '这张图用不了', error instanceof Error ? error.message : String(error))
    }
  }

  async function attachFiles(): Promise<void> {
    const result = await window.workbench?.attachFiles()
    if (!result) {
      showToast('info', '附件', '浏览器演示没有真实文件系统，直接 @ 提文件名也行')
      return
    }
    if (result.canceled) return
    if (!result.ok || !result.files) {
      showToast('error', '附加失败', result.error ?? '读不到内容')
      return
    }

    let added = 0
    const failed: string[] = []
    for (const file of result.files) {
      if (!file.ok) {
        failed.push(`${file.name}：${file.error ?? '读不到'}`)
        continue
      }
      /* 图片交给现有那条预览条（贴图 / 选图走的是同一处） */
      if (file.kind === 'image' && file.dataUrl) addInputImage(file.dataUrl)
      else addInputFile(file)
      added += 1
    }

    if (added > 0) {
      showToast(
        'success',
        `已附加 ${added} 个文件`,
        result.dropped ? `另有 ${result.dropped} 个超出上限，没加` : '',
      )
    }
    if (failed.length > 0) showToast('error', `有 ${failed.length} 个没读成`, failed.join('；'))
  }

  function insertImageMessage(prompt: string, image: string): void {
    const threadId = useAppStore.getState().activeThreadId
    if (!threadId) return

    const message: Message = {
      id: uid('msg'),
      threadId,
      role: 'assistant',
      content: `（生成的图片）${prompt}`,
      kind: 'text',
      status: 'sent',
      timestamp: Date.now(),
      images: [image],
    }
    useAppStore.getState().addMessage(threadId, message)
    useAppStore.getState().persistMessage(threadId, {
      role: 'assistant',
      content: message.content,
      ts: message.timestamp,
    })
  }

  return { attachImage, attachFromClipboard, pickImage, attachFiles, insertImageMessage }
}
