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
  /*
   * 「现在是否贴着底」只用 ref，**不用 state**。
   * 用 state 的话每次跨越阈值都要重渲染，而重渲染在长对话里会改 DOM 高度、
   * 又反过来改滚动位置 —— 就是那个抽搐的燃料。ref 不触发渲染，回路断掉。
   */
  const pinnedRef = useRef(true)
  const [scrollTop, setScrollTop] = useState(0)
  const count = messages.length
  const useWindowing = messages.length > 80
  const estimatedHeight = 150
  /* 多渲染几条 —— 窗口切换得越少，底下那个「改 DOM 高度 → 修正 scrollTop」的循环越不容易被触发 */
  const overscan = 16
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

  /*
   * 用户往上滚了就取消「自动贴底」，滚回底部再恢复。
   *
   * ⚠️ 这里曾经是「每次 scroll 都 setScrollTop(node.scrollTop)」，会抽搐：
   *     setState → 重渲染 → 虚拟窗口范围变 → 渲染的消息条数变 → DOM 高度变
   *     → 浏览器修正 scrollTop → 又触发 scroll → …… 无限循环。
   *   「拉到底端一直抽搐」就是这么来的，而且**只在长对话上出现** ——
   *   因为窗口化只在 > 80 条时启用，短对话根本不走这条路。
   *
   *   现在两道闸：① 滚动量不足半条消息就**不更新**（大多数 scroll 都被吃掉）；
   *   ② 用 rAF 合并同一帧里的多次 scroll。
   */
  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    let frame = 0

    function onScroll(): void {
      const el = node!
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      /*
       * 滞回：贴底状态下要离开 160px 才算「离开」，非贴底状态下滚进 80px 才算「贴上」。
       * 单阈值会在边界上反复跨越，滚回去又跨回来 —— 就成了抽搐。
       */
      pinnedRef.current = pinnedRef.current ? distance < 160 : distance < 80
      if (!useWindowing) return

      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = el.scrollTop
        setScrollTop((prev) => (Math.abs(next - prev) > estimatedHeight / 2 ? next : prev))
      })
    }

    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      node.removeEventListener('scroll', onScroll)
    }
  }, [useWindowing, estimatedHeight])

  /*
   * 贴底只跟着**消息条数**走。
   *
   * 以前依赖里有 pinnedToBottom —— 那是个自激回路：滚到底 → 置 true → 贴底 →
   * 位置微变 → 跨过阈值置 false → …（长对话上还会叠加「窗口化改 DOM 高度」）。
   * 现在读 ref、依赖里只有 count，这条回路就断了：只有真来了新消息才滚。
   */
  useLayoutEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [count])

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
