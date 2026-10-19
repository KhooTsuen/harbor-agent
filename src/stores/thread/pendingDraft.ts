import type { MessageAttachments, QueueEntry } from './messageDraft'

interface PendingDraftState extends MessageAttachments {
  input: string
  drafts: Record<string, string>
  attachmentDrafts: Record<string, MessageAttachments>
  queuedMessages: Record<string, QueueEntry[]>
}

export function migratePendingDraft(
  current: PendingDraftState,
  pendingId: string,
  realId: string,
  sent: { text: string } & MessageAttachments,
  isActive: boolean,
): Pick<PendingDraftState, 'drafts' | 'attachmentDrafts' | 'queuedMessages'> {
  const text = isActive ? current.input : (current.drafts[pendingId] ?? '')
  const files = isActive ? current.files : (current.attachmentDrafts[pendingId]?.files ?? [])
  const images = isActive ? current.images : (current.attachmentDrafts[pendingId]?.images ?? [])
  const unchanged =
    text.trim() === sent.text &&
    files.length === sent.files.length &&
    images.length === sent.images.length &&
    files.every((file, index) => file === sent.files[index]) &&
    images.every((image, index) => image === sent.images[index])
  const drafts = { ...current.drafts, [realId]: unchanged ? '' : text }
  const attachmentDrafts = {
    ...current.attachmentDrafts,
    [realId]: unchanged ? { images: [], files: [] } : { images, files },
  }
  const queuedMessages = { ...current.queuedMessages }
  if (queuedMessages[pendingId]) {
    queuedMessages[realId] = [...(queuedMessages[realId] ?? []), ...queuedMessages[pendingId]]
    delete queuedMessages[pendingId]
  }
  return { drafts, attachmentDrafts, queuedMessages }
}
