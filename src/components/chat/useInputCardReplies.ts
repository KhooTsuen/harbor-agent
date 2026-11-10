import { useRef, useState } from 'react'
import type { InputAction } from '@/types/inputReply'
import type { PermissionRequest } from '@/types'
import type { AppState } from '@/stores/app/types'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { runInputCardAction } from '@/lib/inputCardAction'

export interface InputCardReply {
  request: PermissionRequest
  title: string
  details: readonly string[]
  error?: string
  state?: 'submitting' | 'accepted' | 'local' | 'failed'
}

export type SubmitInputCard = (
  request: PermissionRequest,
  details: readonly string[],
  action: InputAction | undefined,
) => void

function viewScope(state: AppState): string {
  const thread = state.threads.find((item) => item.id === state.activeThreadId)
  return JSON.stringify([
    state.activeThreadId,
    thread?.messages.map((message) => [
      message.id,
      message.diskKey,
      message.execId,
      message.versionIndex,
      message.answersVersion,
      message.answerIndex,
      message.status,
    ]),
  ])
}

/** Submission stays pending until the originating backend callback acknowledges it. */
export function useInputCardReplies() {
  const inFlight = useRef<PermissionRequest | null>(null)
  const scope = useAppStore(viewScope)
  const threadId = useAppStore((state) => state.activeThreadId)
  const permission = useUIStore((state) => state.permission)
  const clarify = useUIStore((state) => state.clarify)
  const [saved, setSaved] = useState({
    scope,
    permission,
    clarify,
    permissionScope: scope,
    clarifyScope: scope,
    permissionKey: 0,
    clarifyKey: 0,
    reply: null as InputCardReply | null,
  })
  let current = saved
  const newPermission = permission !== saved.permission
  const newClarify = clarify !== saved.clarify
  const otherRequest =
    saved.reply &&
    ((permission && permission !== saved.reply.request) ||
      (clarify && clarify !== saved.reply.request))
  if (scope !== saved.scope || newPermission || newClarify || otherRequest) {
    current = {
      ...saved,
      scope,
      permission,
      clarify,
      permissionScope: newPermission ? scope : saved.permissionScope,
      clarifyScope: newClarify ? scope : saved.clarifyScope,
      permissionKey: saved.permissionKey + Number(newPermission),
      clarifyKey: saved.clarifyKey + Number(newClarify),
      reply:
        scope !== saved.scope ||
        otherRequest ||
        (newPermission && permission) ||
        (newClarify && clarify)
          ? null
          : saved.reply,
    }
    setSaved(current)
  }

  const belongsHere = (request: PermissionRequest | null, owner: string) =>
    owner === scope && (!request?.threadId || request.threadId === threadId)

  const submit: SubmitInputCard = async (request, details, action) => {
    const ui = useUIStore.getState()
    if (
      inFlight.current === request ||
      viewScope(useAppStore.getState()) !== scope ||
      (ui.permission !== request && ui.clarify !== request)
    )
      return
    inFlight.current = request
    setSaved((value) => ({
      ...value,
      reply: { request, title: request.title, details, state: 'submitting' },
    }))
    const result = await runInputCardAction(action)
    if (inFlight.current === request) inFlight.current = null
    if (viewScope(useAppStore.getState()) !== scope) return
    setSaved((value) => ({
      ...value,
      reply: {
        request,
        title: request.title,
        details,
        ...result,
      },
    }))
    if (result.state === 'failed') return
    const pending = useUIStore.getState()
    if (pending.permission === request) pending.closePermission(request.confirmId)
    if (pending.clarify === request) pending.closeClarify(request.confirmId)
  }

  return {
    permission: belongsHere(permission, current.permissionScope) ? permission : null,
    clarify: belongsHere(clarify, current.clarifyScope) ? clarify : null,
    permissionKey: `${scope}:${current.permissionKey}`,
    clarifyKey: `${scope}:${current.clarifyKey}`,
    reply: current.reply,
    dismiss: () => setSaved((value) => ({ ...value, reply: null })),
    submit,
  }
}
