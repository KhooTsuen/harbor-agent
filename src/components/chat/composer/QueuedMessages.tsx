/*
 * AG-025：排队中的消息（跑着时用户又发的）。
 *
 * 显示在输入框上方：N 条 + 每条可点 × 删掉。不搞「调整顺序」——
 * 那是后话，先保证「看得见、删得掉」。
 */

export function QueuedMessages({
  list,
  onRemove,
}: {
  list: string[] | undefined
  onRemove: (index: number) => void
}) {
  if (!list || list.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-hairline px-3 py-1.5">
      <span className="text-2xs text-fg-tertiary">排队中 {list.length} 条</span>
      {list.map((text, index) => (
        <span
          key={index}
          className="flex items-center gap-1 rounded-pill bg-bg-raised px-2 py-0.5 text-2xs text-fg-secondary"
        >
          <span className="max-w-[16rem] truncate">{text}</span>
          <button
            type="button"
            aria-label={`删除排队消息 ${index + 1}`}
            onClick={() => onRemove(index)}
            className="text-fg-tertiary transition-colors hover:text-danger"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
