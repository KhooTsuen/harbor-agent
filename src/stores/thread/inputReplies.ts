import type { StoredInputReply, ConfirmationAck } from '@/types/inputReply'
import type { StoredClarify } from '@/types'
import { confirmChat } from '@/lib/backend'
import { toAnswerRecord } from '@/lib/answers'
import { useAppStore } from '../useAppStore'

/** Always bind to the originating execution, including when another version is selected. */
export function recordInputReply(
  event: Record<string, unknown>,
  reply: StoredInputReply,
  clarify?: StoredClarify,
): void {
  const app = useAppStore.getState()
  const threadId = String(event.sessionId ?? event.threadId ?? '')
  const message = app.threads
    .find((thread) => thread.id === threadId)
    ?.messages.find(
      (item) =>
        item.role === 'assistant' &&
        (item.execId === reply.execId ||
          item.answerRecords?.some((answer) => answer.execId === reply.execId)),
    )
  if (!message) return
  const selected = message.execId === reply.execId
  const record = selected
    ? toAnswerRecord(message)
    : message.answerRecords?.find((answer) => answer.execId === reply.execId)
  if (!record) return
  const inputReplies = [
    ...(record.inputReplies ?? []).filter((item) => item.confirmId !== reply.confirmId),
    reply,
  ]
  const updated = { ...record, inputReplies, ...(clarify ? { clarify } : {}) }
  const answerRecords = message.answerRecords?.map((answer) =>
    answer.execId === reply.execId ? updated : answer,
  )
  app.updateMessage(
    threadId,
    message.id,
    selected
      ? {
          inputReplies,
          ...(clarify ? { clarify } : {}),
          ...(answerRecords ? { answerRecords } : {}),
        }
      : { answerRecords },
  )
  app.persistMessage(threadId, {
    ...updated,
    ...(selected && message.status === 'streaming' ? { partial: true } : {}),
  })
}

const submissions = new Map<string, Promise<ConfirmationAck>>()

export function submitCardReply(
  event: Record<string, unknown>,
  approved: boolean,
  details: string[],
  answer?: string,
  clarify?: StoredClarify,
): Promise<ConfirmationAck> {
  const key = `${String(event.requestId ?? '')}:${String(event.confirmId ?? '')}`
  const pending = submissions.get(key)
  if (pending) return pending
  const request = performSubmission(event, approved, details, answer, clarify)
  submissions.set(key, request)
  void request.then((result) => {
    if (!result.ok && submissions.get(key) === request) submissions.delete(key)
  })
  if (submissions.size > 256) submissions.delete(submissions.keys().next().value ?? '')
  return request
}

async function performSubmission(
  event: Record<string, unknown>,
  approved: boolean,
  details: string[],
  answer?: string,
  clarify?: StoredClarify,
): Promise<ConfirmationAck> {
  const confirmId = String(event.confirmId ?? '')
  const execId = String(event.requestId ?? '')
  const reply: StoredInputReply = {
    confirmId,
    execId,
    title:
      String(event.toolName ?? '') === 'ask_user'
        ? '提问与确认'
        : String(event.summary ?? '操作确认'),
    details,
    state: 'submitting',
    at: Date.now(),
  }
  if (confirmId && execId) recordInputReply(event, reply)
  const result = await confirmChat(confirmId, approved, answer)
  if (confirmId && execId)
    recordInputReply(
      event,
      {
        ...reply,
        state: result.ok ? 'accepted' : 'failed',
        ...(result.error ? { error: result.error } : {}),
      },
      result.ok ? clarify : undefined,
    )
  return result
}
