import { collaborationSchema } from '@/types/collaboration'
import type { Message } from '@/types'
import { logAction, logError } from '@/lib/actionLog'

export function readCollaboration(value: unknown, source: string): Message['collaboration'] {
  const parsed = collaborationSchema.safeParse(value)
  if (!parsed.success) {
    logError(
      `collaboration.${source}.invalid`,
      JSON.stringify(
        parsed.error.issues
          .slice(0, 6)
          .map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      ),
    )
    return undefined
  }
  return parsed.data
}

export function handleCollaborationEvent(
  event: Record<string, unknown>,
  patch: (value: Partial<Message>) => void,
  retain?: (value: NonNullable<Message['collaboration']>) => void,
): boolean {
  if (event.type !== 'collab.phase') return false
  const record = readCollaboration(event.state, 'phase')
  if (record) {
    retain?.(record)
    patch({ collaboration: record })
    logAction('collaboration.phase', `${record.id}:${record.phase}:${record.status}`)
  }
  return true
}
