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
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  /*
   * 是否显示「回到底部」的悬浮按钮。
   *
   * 这个 state 只在**跨越阈值**时变（onScroll 里先比再 set），不是每次 scroll
   * 都 set —— 后者会把滚动位置和重渲染搞成回路（见 onScroll 的注释）。
   */
  const [showJump, setShowJump] = useState(false)
  /**
   * 内容容器的 callback ref —— 挂载时挂上 ResizeObserver（见下面的贴底说明）。
   *
   * 用 callback ref 而不是 `useEffect` + `querySelector`：空状态和列表状态是
   * **两棵不同的树**，切来切去时只想把 observer 正确地挂到当时那个节点上。
   */
  const attachContent = (node: HTMLDivElement | null): void => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (!node) return
    const ro = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      const sc = scrollerRef.current
      if (sc) sc.scrollTop = sc.scrollHeight
    })
    ro.observe(node)
    resizeObserverRef.current = ro
  }
  const [scrollTop, setScrollTop] = useState(0)
  const count = messages.length
  /*
   * 虚拟滚动暂时关掉（阈值提到不可能达到）。
   *
   * 原来的实现用固定 150px 估算每条高度，但真实消息高度能差几十倍 ——
   * 超长对话一滚就飘。要么老老实实用「逐条实测高度 + 绝对定位占位」重写，
   * 要么就别虚拟滚动：385 条全渲染的代价是初始渲染慢一点，但滚动是
   * CSS 原生滚动，不会飘。先全渲染，等单个对话真的长到会卡再重写。
   */
  const useWindowing = messages.length > 1_000_000
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
      /* 只在真的离开底部时把按钮亮出来（先比再 set，避免无意义的重渲染） */
      setShowJump((prev) => (prev === !pinnedRef.current ? prev : !pinnedRef.current))
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
   * 贴底：盯**内容高度**，不盯消息条数。
   *
   * ⚠️ 这里曾经依赖 `[count]`（消息条数），注释还写着「只有真来了新消息才滚」。
   * 当时是为了断开一个自激回路，但代价是：**流式期间内容一直在长而条数不变，
   * 于是完全不滚**。用户看到的就是「视口钉在原地，同一块地方内容在换」——
   * 后来的内容全落在看不见的下方。
   *
   * 改用 ResizeObserver 盯内容容器的高度：
   *   · 流式文字变长     → 高度变 → 贴底 ✓
   *   · 图片/代码块加载   → 高度变 → 贴底 ✓
   *   · 用户往上滚了      → pinned 为 false → 不动 ✓
   *
   * 不会退回自激：我们是直接 `scrollTop = scrollHeight`，滚完 distance ≈ 0，
   * onScroll 读到的是「还贴着底」，pinned 保持 true，不产生来回跳。
   */
  useEffect(() => {
    return () => resizeObserverRef.current?.disconnect()
  }, [])

  /* 消息条数变了也要贴一次（新消息上来时高度可能还没稳） */
  useLayoutEffect(() => {
    if (!pinnedRef.current) return
    const sc = scrollerRef.current
    if (sc) sc.scrollTop = sc.scrollHeight
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
    <div className="relative min-h-0 flex-1">
      <div ref={scrollerRef} className="h-full overflow-y-auto">
        <div ref={attachContent} className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-5">
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

      {/*
       * 「回到底部」。
       *
       * 只在**用户自己往上滚了**（pinned 为 false）的时候出现 —— 正在往上翻历史时，
       * Agent 还在后面写，得要个东西告诉他「后面有新的」。
       *
       * 不用额外判断「是不是在流式」：不流式时内容高度不变，用户不滚就永远不会
       * 离开底部。
       */}
      {showJump ? (
        <button
          type="button"
          onClick={() => {
            const sc = scrollerRef.current
            if (sc) sc.scrollTop = sc.scrollHeight
            pinnedRef.current = true
            setShowJump(false)
          }}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-pill border border-line-hairline bg-bg-raised px-3 py-1.5 text-2xs text-fg-secondary shadow-lg transition-colors hover:text-fg-primary"
        >
          ↓ 回到底部
        </button>
      ) : null}
    </div>
  )
}
