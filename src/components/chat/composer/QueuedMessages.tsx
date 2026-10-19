/*
 * AG-025：排队中的消息（跑着时用户又发的）。
 *
 * 显示在输入框上方：N 条 + 每条可点 × 删掉。不搞「调整顺序」——
 * 那是后话，先保证「看得见、删得掉」。
 */

import { queuedMessage, type QueueEntry } from '@/stores/thread/messageDraft'
import { attachBlock } from '@/stores/thread/attachments'

export function QueuedMessages({
  list,
  onRemove,
}: {
  list: QueueEntry[] | undefined
  onRemove: (index: number) => void
}) {
  if (!list || list.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-hairline px-3 py-1.5">
      <span className="text-2xs text-fg-tertiary">排队中 {list.length} 条</span>
      {list.map((text, index) => (
        <div
          key={index}
          className="flex items-center gap-1 rounded-pill bg-bg-raised px-2 py-0.5 text-2xs text-fg-secondary"
        >
          <span className="max-w-[16rem] truncate">
            {queuedMessage(text).text || '附件消息'}
            {queuedMessage(text).images.length > 0
              ? ` · ${queuedMessage(text).images.length} 张图片`
              : ''}
            {queuedMessage(text)
              .files.map((file) => ` · ${file.name}`)
              .join('')}
          </span>
          <button
            type="button"
            aria-label={`删除排队消息 ${index + 1}`}
            onClick={() => onRemove(index)}
            className="text-fg-tertiary transition-colors hover:text-danger"
          >
            ×
          </button>
          {queuedMessage(text).files.length > 0 ? (
            <details className="max-w-[20rem]">
              <summary className="cursor-pointer">查看队列附件内容</summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-2">
                {attachBlock(queuedMessage(text).files)}
              </pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  )
}
