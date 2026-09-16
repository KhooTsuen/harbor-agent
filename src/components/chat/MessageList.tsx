import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@/types'
import { MessageItem } from './MessageItem'
import { AsciiBanner } from './AsciiBanner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { EMPTY_THREAD_PROMPTS } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   MessageList

   滚动策略：只在「消息条数变化」时贴底，用户手动上滚看历史时不打扰。
   用 useLayoutEffect 而不是 useEffect —— 要在浏览器绘制之前滚，
   否则会先看到内容跳一下再滚。
   ══════════════════════════════════════════════════════════════ */

export interface MessageListProps {
  messages: readonly Message[]
  /** 空状态下的建议提示 */
  onSuggestion: (text: string) => void
}

export function MessageList({ messages, onSuggestion }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const count = messages.length
  const useWindowing = messages.length > 80
  const estimatedHeight = 150
  const overscan = 8
  const windowStart = useWindowing
    ? Math.max(0, Math.floor(scrollTop / estimatedHeight) - overscan)
    : 0
  const windowEnd = useWindowing
    ? Math.min(messages.length, Math.ceil((scrollTop + 900) / estimatedHeight) + overscan)
    : messages.length
  const visibleMessages = useMemo(
    () => messages.slice(windowStart, windowEnd),
    [messages, windowStart, windowEnd],
  )

  /* 用户往上滚了就取消「自动贴底」，滚回底部再恢复 */
  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    function onScroll(): void {
      const distance = node!.scrollHeight - node!.scrollTop - node!.clientHeight
      setPinnedToBottom(distance < 80)
      if (useWindowing) setScrollTop(node?.scrollTop ?? 0)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [useWindowing])

  useLayoutEffect(() => {
    if (pinnedToBottom) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [count, pinnedToBottom])

  if (messages.length === 0) {
    /*
      justify-evenly 而不是 center：空白在「上 / 图与卡片之间 / 下」三等分，
      图自然靠上、卡片自然靠下 —— 就是标注里「下移到这个位置」那个效果。
      center + 固定 gap 做不到这件事：居中会吃掉一半位移。
    */
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-evenly overflow-y-auto px-6 py-8">
        {/* 装饰横幅：上面放图，下面放「想让 Agent 做什么」（顺序不要换） */}
        <AsciiBanner />
        <EmptyState
          title="想让 Agent 做什么？"
          description="描述你想要的改动，或者贴一段代码问为什么。左侧可以同时开多个线程并行跑。"
          action={
            <div className="flex max-w-xl flex-wrap justify-center gap-2">
              {EMPTY_THREAD_PROMPTS.map((prompt) => (
                <Button
                  key={prompt}
                  variant="secondary"
                  size="sm"
                  onClick={() => onSuggestion(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-5">
        {useWindowing && windowStart > 0 ? (
          <div style={{ height: windowStart * estimatedHeight }} aria-hidden="true" />
        ) : null}
        {visibleMessages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
        {useWindowing && windowEnd < messages.length ? (
          <div
            style={{ height: (messages.length - windowEnd) * estimatedHeight }}
            aria-hidden="true"
          />
        ) : null}
        <div ref={bottomRef} className="h-px" />
      </div>
    </div>
  )
}
