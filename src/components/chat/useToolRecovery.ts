import { useEffect, useRef, useState } from 'react'
import type { ToolRunState } from './toolRunState'
import type { ToolRunRecord } from '@/types'

/** Recovery requires an observed failure or a recorded backend retry relationship. */
export function useToolRecovery(
  id: string,
  state: ToolRunState,
  motion: boolean,
  run?: ToolRunRecord,
) {
  const previous = useRef({ id, failed: state === 'failed' })
  const [recoveredFor, setRecoveredFor] = useState<string | null>(null)
  const linkedRecovery = Boolean(run?.recoveredBy)
  const retrying =
    Boolean(run?.retryingBy) ||
    (state === 'running' &&
      (Boolean(run?.retryOf || run?.retryAttempt) ||
        (previous.current.id === id && previous.current.failed)))

  useEffect(() => {
    if (previous.current.id !== id) {
      previous.current = { id, failed: state === 'failed' }
      setRecoveredFor(null)
    } else if (
      linkedRecovery ||
      (state === 'completed' &&
        (previous.current.failed || Boolean(run?.retryOf || run?.retryAttempt)))
    ) {
      previous.current.failed = false
      if (motion) setRecoveredFor(id)
    } else if (state === 'failed') {
      previous.current.failed = true
      setRecoveredFor(null)
    }
  }, [id, state, motion, linkedRecovery, run?.retryOf, run?.retryAttempt])

  useEffect(() => {
    if (!recoveredFor) return
    const timer = window.setTimeout(() => setRecoveredFor(null), 2000)
    return () => window.clearTimeout(timer)
  }, [recoveredFor])

  return { recovered: recoveredFor === id && (state === 'completed' || linkedRecovery), retrying }
}
