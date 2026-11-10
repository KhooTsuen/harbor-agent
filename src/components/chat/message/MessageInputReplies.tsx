import type { Message } from '@/types'
import { FlowDisclosure } from './FlowDisclosure'

export function MessageInputReplies({ message }: { message: Message }) {
  const replies = message.inputReplies ?? []
  if (message.status === 'streaming' || !replies.length) return null
  return (
    <FlowDisclosure
      label={`确认与答复 · ${replies.length} 条`}
      memoryKey={`${message.threadId}:${message.diskKey ?? message.id}:${message.execId}:replies`}
    >
      <ul className="flex flex-col gap-2 text-xs text-fg-secondary">
        {replies.map((reply) => (
          <li key={reply.confirmId} className="flow-submitted-card">
            <p>{reply.title}</p>
            <p className="mt-1 text-2xs text-fg-tertiary">
              {reply.state === 'accepted'
                ? '后台已收到答复'
                : reply.state === 'failed'
                  ? '答复未被后台接受'
                  : '答复是否送达未确认'}
            </p>
            {reply.details.map((detail, i) => (
              <p key={i} className="mt-1 whitespace-pre-wrap break-words">
                {detail}
              </p>
            ))}
            {reply.error ? <p className="flow-action-error">{reply.error}</p> : null}
          </li>
        ))}
      </ul>
    </FlowDisclosure>
  )
}
