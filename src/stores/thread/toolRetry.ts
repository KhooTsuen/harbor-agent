import type { ToolRunRecord } from '@/types'

/** The backend supplies provenance. A same-name call alone is never recovery evidence. */
export function applyRetryLink(runs: ToolRunRecord[], run: ToolRunRecord, retryOf?: unknown): void {
  const predecessor =
    typeof retryOf === 'string' ? runs.find((item) => item.id === retryOf) : undefined
  if (
    predecessor &&
    predecessor.id !== run.id &&
    predecessor.name === run.name &&
    !predecessor.ok &&
    !predecessor.pending
  )
    run.retryOf = predecessor.id
  const seen = new Set<string>([run.id])
  let parentId = run.retryOf
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = runs.find((item) => item.id === parentId)
    if (!parent || parent.name !== run.name || parent.ok) break
    if (run.pending) {
      parent.retryingBy = run.id
      delete parent.recoveredBy
    } else if (parent.retryingBy === run.id || !parent.retryingBy) {
      delete parent.retryingBy
      if (run.ok) parent.recoveredBy = run.id
    }
    parentId = parent.retryOf
  }
}

export function applyRetryNotice(runs: ToolRunRecord[], event: Record<string, unknown>): boolean {
  const run = runs.find((item) => item.id === event.toolCallId)
  if (
    !run ||
    typeof event.attempt !== 'number' ||
    !Number.isSafeInteger(event.attempt) ||
    event.attempt < 1
  )
    return false
  run.retryAttempt = event.attempt
  run.pending = true
  applyRetryLink(runs, run, event.retryOf)
  return true
}
