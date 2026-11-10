import { useRef, useState } from 'react'
import type { PermissionRequest } from '@/types'
import { runInputCardAction } from '@/lib/inputCardAction'
import { useUIStore } from '@/stores/useUIStore'
import type { InputCardReply, SubmitInputCard } from './useInputCardReplies'

/** Standalone card mounts use the same acknowledgement rules as the composer. */
export function useFallbackCardReply(request: PermissionRequest | null) {
  const current = useRef(request)
  current.current = request
  const pending = useRef<PermissionRequest | null>(null)
  const [reply, setReply] = useState<InputCardReply | null>(null)
  const submit: SubmitInputCard = async (owner, details, action) => {
    if (pending.current === owner || current.current !== owner) return
    pending.current = owner
    const receipt = { request: owner, title: owner.title, details }
    setReply({ ...receipt, state: 'submitting' })
    const result = await runInputCardAction(action)
    if (pending.current === owner) pending.current = null
    if (current.current !== owner) return
    setReply({ ...receipt, ...result })
    if (result.state === 'failed') return
    const ui = useUIStore.getState()
    if (ui.permission === owner) ui.closePermission(owner.confirmId)
    if (ui.clarify === owner) ui.closeClarify(owner.confirmId)
  }
  return {
    reply: reply?.request === request ? reply : null,
    submit,
    dismiss: () => setReply(null),
  }
}
