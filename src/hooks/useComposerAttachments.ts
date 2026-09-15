import type { Message } from '@/types'
import { extToLanguage, fsPickAndRead } from '@/lib/fsApi'
import { uid } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   Composer 的附件操作

   三类：贴图、加文本文件、把生成的图片插进对话。
   从 Composer 拆出来的 —— 那边贴着 300 行，而这些逻辑
   和「输入框长什么样」是两回事。
   ══════════════════════════════════════════════════════════════ */

export interface ComposerAttachments {
  /** 加一张图（data URL）。粘贴和选文件都走这里 */
  attachImage: (dataUrl: string) => void
  pickImage: () => Promise<void>
  /** 读一个文本文件，把内容以代码块形式追加到输入框 */
  attachFile: () => Promise<void>
  /** 把生成的图片作为一条消息插进当前对话 */
  insertImageMessage: (prompt: string, image: string) => void
}

export function useComposerAttachments(): ComposerAttachments {
  const addInputImage = useThreadStore((s) => s.addInputImage)
  const input = useThreadStore((s) => s.input)
  const setInput = useThreadStore((s) => s.setInput)
  const showToast = useUIStore((s) => s.showToast)

  function attachImage(dataUrl: string): void {
    if (!dataUrl.startsWith('data:image/')) return
    addInputImage(dataUrl)
  }

  async function pickImage(): Promise<void> {
    const picked = await window.workbench?.pickImageAsDataUrl()
    if (!picked || picked.canceled) return
    if (!picked.ok || !picked.dataUrl) {
      showToast('error', '读图失败', picked.error)
      return
    }
    attachImage(picked.dataUrl)
  }

  async function attachFile(): Promise<void> {
    const result = await fsPickAndRead()
    if (!result) {
      showToast('info', '附件', '浏览器演示没有真实文件系统，直接 @ 提文件名也行')
      return
    }
    if (result.canceled) return
    if (!result.ok || result.text === undefined) {
      showToast('error', '附加失败', result.error ?? '读不到内容')
      return
    }

    const ext = (result.name ?? '').split('.').pop() ?? ''
    const block = `\n\n\`\`\`${extToLanguage(ext)}\n// ${result.name}\n${result.text}\n\`\`\``
    setInput(input + block)
    showToast('success', '已附加', result.name)
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

  return { attachImage, pickImage, attachFile, insertImageMessage }
}
