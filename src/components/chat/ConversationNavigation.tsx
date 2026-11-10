import type { Message } from '@/types'
import { bodyTextOf } from '@/lib/bodyText'
import { navigateToFlow } from '@/lib/flowNavigation'
import { useUIStore } from '@/stores/useUIStore'
import '@/styles/conversation-navigation.css'

interface Props {
  messages: readonly Message[]
  conversationId: string
  free: boolean
  hasNewContent: boolean
  canReturn: boolean
  returnToReading: () => void
  enterFollow: () => void
}

export function ConversationNavigation({
  messages,
  conversationId,
  free,
  hasNewContent,
  canReturn,
  returnToReading,
  enterFollow,
}: Props) {
  const permission = useUIStore((state) => state.permission)
  const clarify = useUIStore((state) => state.clarify)
  const waiting = [permission, clarify].some(
    (request) => request && (!request.threadId || request.threadId === conversationId),
  )
  const answer = [...messages].reverse().find((message) => message.role === 'assistant')
  const final = answer === messages.at(-1) && answer?.status === 'sent' && bodyTextOf(answer)
  const focusCard = () => {
    const card = document.querySelector<HTMLElement>('[data-flow-user-input="true"]')
    if (!card) return
    card.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    const focus = card.querySelector<HTMLElement>('button, input, textarea, [tabindex]') ?? card
    focus.focus({ preventScroll: true })
  }
  /*
   * FREE（看历史）就必须能一键回底 —— 不只是「有新内容」的时候。
   * 2026-11-10 恢复：之前只在 hasNewContent / waiting 时显示，
   * 于是滚到中间、又没有新内容时，屏幕上没有任何回到底部的入口。
   */
  if (!canReturn && !free) return null
  return (
    <nav className="flow-navigation" aria-label="对话阅读位置">
      {canReturn ? (
        <button type="button" onClick={returnToReading}>
          ↩ 返回阅读位置
        </button>
      ) : null}
      {free && waiting ? (
        <button type="button" className="flow-navigation-new" onClick={focusCard}>
          需要你答复
        </button>
      ) : null}
      {/*
       * FREE 时永远给一个回底入口（不只「有新内容」时）。
       * 「需要你答复」已经占了一条按钮，这时不再叠第二条回底。
       */}
      {free && !waiting ? (
        <button
          type="button"
          className="flow-navigation-new"
          onClick={() => {
            if (final && answer) navigateToFlow(answer.id, `flow-answer-${answer.id}`)
            else enterFollow()
          }}
        >
          {final ? '↓ 查看最终答复' : hasNewContent ? '↓ 有新内容 · 回到底部' : '↓ 回到底部'}
        </button>
      ) : null}
    </nav>
  )
}

export function RecoveryMarker({ message }: { message: Message }) {
  if (!message.interrupted || message.role !== 'assistant') return null
  const pending = message.toolRuns?.filter((run) => run.pending).length ?? 0
  const last = message.flow?.nodes.at(-1)
  return (
    <aside className="flow-recovery-marker" id={`flow-recovery-${message.id}`}>
      <span>上次执行未完成 · 已保留最后保存的进度</span>
      {pending ? <span> · {pending} 项工具结果未确认</span> : null}
      <button
        type="button"
        onClick={() =>
          navigateToFlow(message.id, last ? `flow-node-${message.id}-${last.id}` : undefined)
        }
      >
        定位保存位置
      </button>
    </aside>
  )
}
