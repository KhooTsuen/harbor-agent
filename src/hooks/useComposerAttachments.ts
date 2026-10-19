import type { ClipboardEvent } from 'react'
import type { Message } from '@/types'
import { looksLikeImage } from '@/lib/imageFormat'
import { normalizeDataUrl, normalizeImage } from '@/lib/imageNormalize'
import { uid } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import type { AttachedFile } from '@/types/backend-io'
import { resolveDraftOwner } from '@/stores/thread/draftOwner'
import { useAttachmentActivity } from '@/stores/attachmentActivity'

function addToConversation(owner: string | null, image?: string, file?: AttachedFile): boolean {
  owner = resolveDraftOwner(owner)
  const store = useThreadStore.getState()
  const app = useAppStore.getState()
  const active = app.activeThreadId
  if (!owner || !app.threads.some((thread) => thread.id === owner)) return false
  const saved =
    owner === active
      ? { images: store.inputImages, files: store.inputFiles }
      : (store.attachmentDrafts[owner] ?? { images: [], files: [] })
  if (!saved || (image && saved.images.length >= 5) || (file && saved.files.length >= 5))
    return false
  const next = {
    images: image ? [...saved.images, image] : saved.images,
    files: file ? [...saved.files, file] : saved.files,
  }
  if (owner === active)
    useThreadStore.setState({ inputImages: next.images, inputFiles: next.files })
  else if (owner)
    useThreadStore.setState({ attachmentDrafts: { ...store.attachmentDrafts, [owner]: next } })
  return true
}

function originNote(owner: string | null): string {
  return resolveDraftOwner(owner) === useAppStore.getState().activeThreadId
    ? ''
    : '结果已归入发起操作的对话'
}

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
  const showToast = useUIStore((s) => s.showToast)
  const noteFailure = (owner: string | null, message: string) =>
    useAttachmentActivity.getState().fail(owner, message)

  function attachImage(dataUrl: string): void {
    if (!dataUrl.startsWith('data:image/')) {
      noteFailure(useAppStore.getState().activeThreadId, '图片格式无效')
      showToast('error', '图片未添加', '图像格式无效')
      return
    }
    if (!addToConversation(useAppStore.getState().activeThreadId, dataUrl))
      showToast('warning', '图片未添加', '已达到附件数量上限')
  }

  /** 归整好再加进去；转过了就告诉用户一声（静默转换会让人以为图被改坏了） */
  async function attachBlob(blob: Blob, owner: string | null): Promise<void> {
    const token = useAttachmentActivity.getState().begin(owner)
    try {
      const { dataUrl, changed, reason } = await normalizeImage(blob)
      if (!addToConversation(owner, dataUrl)) {
        noteFailure(owner, '图片数量超限或原对话已不可用')
        showToast('warning', '图片未添加', '已达到附件数量上限或原对话已不可用')
        return
      }
      if (changed)
        showToast('info', '图片已转换', [reason, originNote(owner)].filter(Boolean).join('；'))
    } catch (error) {
      noteFailure(owner, '图片转换失败')
      showToast('error', '这张图用不了', error instanceof Error ? error.message : String(error))
    } finally {
      useAttachmentActivity.getState().end(token)
    }
  }

  function attachFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    const files = Array.from(event.clipboardData?.files ?? []).filter(looksLikeImage)
    if (files.length === 0) return false
    const owner = useAppStore.getState().activeThreadId
    for (const file of files) void attachBlob(file, owner)
    return true
  }

  async function pickImage(): Promise<void> {
    const owner = useAppStore.getState().activeThreadId
    const token = useAttachmentActivity.getState().begin(owner)
    try {
      const picked = await window.workbench?.pickImageAsDataUrl()
      if (!picked || picked.canceled) return
      if (!picked.ok || !picked.dataUrl) {
        noteFailure(owner, '选中的图片无法读取')
        showToast('error', '读图失败', picked.error)
        return
      }
      try {
        const { dataUrl, changed, reason } = await normalizeDataUrl(picked.dataUrl)
        if (!addToConversation(owner, dataUrl)) {
          noteFailure(owner, '图片数量超限或原对话已不可用')
          showToast('warning', '图片未添加', '已达到附件数量上限或原对话已不可用')
          return
        }
        if (changed)
          showToast('info', '图片已转换', [reason, originNote(owner)].filter(Boolean).join('；'))
      } catch (error) {
        noteFailure(owner, '图片转换失败')
        showToast('error', '这张图用不了', error instanceof Error ? error.message : String(error))
      }
    } catch (error) {
      noteFailure(owner, '选图操作失败')
      showToast('error', '选图失败', error instanceof Error ? error.message : String(error))
    } finally {
      useAttachmentActivity.getState().end(token)
    }
  }

  async function attachFiles(): Promise<void> {
    const owner = useAppStore.getState().activeThreadId
    const token = useAttachmentActivity.getState().begin(owner)
    try {
      const result = await window.workbench?.attachFiles()
      if (!result) {
        showToast('info', '附件', '浏览器演示没有真实文件系统，直接 @ 提文件名也行')
        return
      }
      if (result.canceled) return
      if (!result.ok || !result.files) {
        noteFailure(owner, '文件无法读取')
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
        const accepted =
          file.kind === 'image' && file.dataUrl
            ? addToConversation(owner, file.dataUrl)
            : addToConversation(owner, undefined, file)
        if (accepted) added += 1
        else failed.push(`${file.name}：数量超限或原对话已不可用`)
      }

      if (added > 0) {
        showToast(
          'success',
          `已附加 ${added} 个文件`,
          [result.dropped ? `另有 ${result.dropped} 个超出上限，没加` : '', originNote(owner)]
            .filter(Boolean)
            .join('；'),
        )
      }
      if (failed.length > 0) showToast('error', `有 ${failed.length} 个没读成`, failed.join('；'))
      if (failed.length > 0 && added === 0) noteFailure(owner, failed.join('；'))
      if (result.dropped && added === 0) {
        noteFailure(owner, `${result.dropped} 个文件超出数量上限`)
        showToast('warning', '附件未添加', `${result.dropped} 个文件超出数量上限`)
      }
    } catch (error) {
      noteFailure(owner, '文件添加失败')
      showToast('error', '附加失败', error instanceof Error ? error.message : String(error))
    } finally {
      useAttachmentActivity.getState().end(token)
    }
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
