import { pauseChat } from '@/lib/chatControl'
import { taskUpdate } from '@/lib/safetyApi'

interface PauseIntent {
  taskId: string
  ended: boolean
  accepted: boolean
}

const intents = new Map<string, PauseIntent>()

export function discardConfirmationPause(requestId: string): void {
  intents.delete(requestId)
}

/** Register before replying: done can arrive before the confirmation IPC resolves. */
export async function prepareConfirmationPause(
  event: Record<string, unknown>,
): Promise<(accepted: boolean) => void> {
  const requestId = String(event.requestId ?? '')
  const taskId = String(event.taskId ?? '')
  const intent = { taskId, ended: false, accepted: false }
  if (requestId && taskId) intents.set(requestId, intent)
  if (requestId) await pauseChat(requestId)
  return (accepted) => {
    if (intents.get(requestId) !== intent) return
    if (!accepted) {
      intents.delete(requestId)
      return
    }
    intent.accepted = true
    if (intent.ended) applyPauseAfterTurn(requestId)
  }
}

/** Write after both backend acceptance and the task's final completion write. */
export function applyPauseAfterTurn(requestId: string): void {
  const intent = intents.get(requestId)
  if (!intent) return
  intent.ended = true
  if (!intent.accepted) return
  intents.delete(requestId)
  void taskUpdate(intent.taskId, {
    status: 'paused',
    pausedAt: Date.now(),
    pauseReason: 'user',
  })
}
