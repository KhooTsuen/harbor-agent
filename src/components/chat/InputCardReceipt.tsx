import { AlertTriangle, CircleCheck, LoaderCircle, X } from 'lucide-react'
export { clarifyReplyDetails } from '@/lib/inputReplyDetails'
import type { InputCardReply } from './useInputCardReplies'
import '@/styles/conversation-tools.css'

export function InputCardReceipt({
  reply,
  canRetry,
  onDismiss,
}: {
  reply: InputCardReply
  canRetry: boolean
  onDismiss: () => void
}) {
  const failed = Boolean(reply.error)
  const Icon = failed ? AlertTriangle : reply.state === 'submitting' ? LoaderCircle : CircleCheck
  return (
    <section className="flow-submitted-card mb-2 bg-bg-raised" aria-label="答复回执" role="status">
      <div className="flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-primary">
            {failed
              ? '提交未完成'
              : reply.state === 'submitting'
                ? '正在发送答复'
                : reply.state === 'accepted'
                  ? '后台已收到答复'
                  : '答复已记录'}
          </p>
          <p className="mt-0.5 truncate text-2xs text-fg-tertiary">{reply.title}</p>
          <ul className="mt-1 max-h-28 overflow-auto text-2xs text-fg-secondary">
            {reply.details.map((detail, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                {detail}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-fg-tertiary">
            {failed
              ? reply.error
              : reply.state === 'submitting'
                ? '等待后台确认。'
                : reply.state === 'accepted'
                  ? '已确认收到；执行结果请看对话中的实际反馈。'
                  : '等待后台确认；执行结果以对话中的实际反馈为准。'}
          </p>
          {failed && canRetry ? (
            <button type="button" onClick={onDismiss} className="flow-tool-load-earlier mt-1">
              返回重试
            </button>
          ) : null}
        </div>
        {reply.state !== 'submitting' ? (
          <button
            type="button"
            aria-label={failed && canRetry ? '返回答复卡片' : '关闭答复回执'}
            onClick={onDismiss}
            className="flow-tool-load-earlier shrink-0"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
    </section>
  )
}
