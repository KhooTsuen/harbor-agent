import type { AttachedFile } from '@/types/backend-io'
import { usableFiles } from './attachments'
import type { MessageAttachments } from './messageDraft'

/* ══════════════════════════════════════════════════════════════
   发送前先把「这一轮到底发什么」算清楚

   从 `useThreadStore.sendMessage` 抽出来的。两个理由：
     · 那边贴着 300 行红线（这段一塞就破掉，而它是可纯函数化的）；
     · 「什么才算有内容」是一条**能单独说清、也值得单独测**的规则 ——
       它决定会不会发出一条空壳消息（P1 #29）。

   ── 规则 ──────────────────────────────────────────────────────
   ① 附件里的图片会被提升成多模态图片（和贴图走同一处）；
   ② **读失败的附件不算内容** —— 它们不会拼进正文（`attachBlock` 同样过滤），
      把 `files.length` 当成「有内容」会发出一条只有占位文字的空消息；
   ③ 真的什么都没有 → 返回 null，调用方直接不发。
   ══════════════════════════════════════════════════════════════ */

export interface Outgoing {
  /** 正文（没有文字但有附件时是那句「请先问我」的占位语） */
  raw: string
  /** 这一轮带的附件（含读失败的 —— 队列/草稿要原样保留） */
  files: AttachedFile[]
  /** 要发出去的多模态图片（已去重） */
  images: string[]
}

/** 「什么都没写也没附件」时交给模型的那句话（用户意图不明时由助手澄清） */
export const NO_TEXT_PLACEHOLDER = '（仅附附件，尚未说明任务。请先问我希望你如何处理这些附件。）'

export function prepareOutgoing(input: {
  text: string
  attachments?: MessageAttachments
  draftFiles: AttachedFile[]
  draftImages: string[]
}): Outgoing | null {
  const files = input.attachments?.files ?? input.draftFiles
  const draftImages = input.attachments?.images ?? input.draftImages
  const images = [
    ...new Set([
      ...draftImages,
      ...files
        .filter((file) => file.ok && file.kind === 'image' && file.dataUrl)
        .map((file) => file.dataUrl!),
    ]),
  ]
  const typed = input.text.trim()
  if (!typed && images.length === 0 && usableFiles(files).length === 0) return null
  return { raw: typed || NO_TEXT_PLACEHOLDER, files, images }
}
