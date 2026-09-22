import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Message } from '@/types'

/**
 * 系统消息（压缩点 / 提示条）。
 *
 * 从 MessageItem 抽出来的（那边贴着 300 行上限，而这一块自成一体：
 * 它只读 message 的两个字段，跟助手/用户那两条渲染路径没有关系）。
 *
 * 压缩点带摘要（挂在 reasoning 上），点一下能展开看摘要内容。
 */
export function SystemMessage({ message }: { message: Message }) {
  const [summaryOpen, setSummaryOpen] = useState(false)

  if (message.reasoning) {
    return (
      <div className="flex flex-col items-center gap-1 py-1">
        <button
          type="button"
          onClick={() => setSummaryOpen((v) => !v)}
          aria-expanded={summaryOpen}
          className="flex items-center gap-1.5 rounded-pill bg-bg-raised px-2.5 py-1 text-2xs text-fg-secondary transition-colors hover:text-fg-primary"
        >
          {summaryOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {message.content}
        </button>
        {summaryOpen ? (
          <div className="max-w-[70ch] whitespace-pre-wrap rounded border border-line-hairline bg-bg-surface/50 px-3 py-2 text-2xs leading-relaxed text-fg-tertiary">
            {message.reasoning}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex justify-center py-1">
      <span className="rounded-pill bg-bg-raised px-2.5 py-1 text-2xs text-fg-secondary">
        {message.content}
      </span>
    </div>
  )
}
