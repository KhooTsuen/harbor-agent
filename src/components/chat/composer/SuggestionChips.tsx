import { RefreshCw, Sparkles } from 'lucide-react'
import { useThreadStore } from '@/stores/useThreadStore'
import { refreshSuggestions } from '@/stores/thread/sceneTasks'
import { useAgentActive } from '@/hooks/useAgentActive'

/* ══════════════════════════════════════════════════════════════
   建议回复

   一轮结束后，用「建议回复」那个场景的模型生成几条后续问题，
   点一下直接填进输入框 —— 不用自己想接下来问什么。

   生成失败就不显示（不弹错误），它是个锦上添花的东西。
   ══════════════════════════════════════════════════════════════ */

export interface SuggestionChipsProps {
  threadId: string
  onPick: (text: string) => void
}

export function SuggestionChips({ threadId, onPick }: SuggestionChipsProps) {
  const suggestions = useThreadStore((s) => s.suggestions)
  /* 这条对话在跑就不显示 —— 别的对话跑着不影响 */
  const sending = useAgentActive(threadId)

  /* 生成中、或者没有建议时都不占地方 */
  if (sending || suggestions.length === 0) return null

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      <Sparkles size={12} className="shrink-0 text-fg-tertiary" aria-hidden="true" />
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          title={text}
          className="max-w-72 truncate rounded-pill border border-line-hairline bg-bg-raised/50 px-2.5 py-1 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          {text}
        </button>
      ))}
      <button
        type="button"
        onClick={() => void refreshSuggestions(threadId)}
        aria-label="再想几个"
        title="再想几个"
        className="shrink-0 rounded-pill p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
      >
        <RefreshCw size={11} />
      </button>
    </div>
  )
}
