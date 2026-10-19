import type { AttachedFile } from '@/types/backend-io'

/** 待发内容属于一条对话；队列与草稿使用同一附件形状。 */
export interface MessageAttachments {
  images: string[]
  files: AttachedFile[]
}

export interface QueuedMessage extends MessageAttachments {
  text: string
}

export type QueueEntry = string | QueuedMessage

export function queuedMessage(entry: QueueEntry): QueuedMessage {
  return typeof entry === 'string' ? { text: entry, images: [], files: [] } : entry
}
