import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import type { ScrollMode } from '@/stores/useScrollStore'
import {
  FLOW_NAVIGATION_EVENT,
  moveToFlowTarget,
  prepareFlowTarget,
  readingPosition,
  readingTop,
  registerFlowScroller,
  revealFlowTarget,
  type FlowNavigationTarget,
  type FlowReadingPosition,
  type FlowScrollAccess,
} from '@/lib/flowNavigation'

interface Options extends FlowScrollAccess {
  conversationId: string
  messages: readonly Message[]
  renderedCount: number
  mode: ScrollMode
  loading: boolean
  enterFree: () => void
  revealMessage: (messageId: string) => void
}

function contentStamp(messages: readonly Message[]): string {
  const last = messages.at(-1)
  if (!last) return ''
  const node = last.flow?.nodes.at(-1)
  const tool = last.toolRuns?.at(-1)
  return [
    messages.length,
    last.id,
    last.status,
    last.content.length,
    last.reasoning?.length,
    last.flow?.nodes.length,
    node && 'text' in node ? node.text.length : '',
    last.flow?.final?.length,
    last.toolRuns?.length,
    tool?.pending,
    tool?.ok,
    tool?.output.length,
    tool?.progress?.percent,
    tool?.progress?.note,
    last.verdict,
    last.interrupted,
    last.truncated,
    last.artifacts?.length,
  ].join(':')
}

export function useConversationNavigation({
  conversationId,
  messages,
  renderedCount,
  mode,
  loading,
  enterFree,
  revealMessage,
  seek,
  position,
}: Options) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const unregister = useRef<() => void>(() => {})
  const cancelMove = useRef<() => void>(() => {})
  const [pending, setPending] = useState<FlowNavigationTarget | null>(null)
  const [returnTo, setReturnTo] = useState<FlowReadingPosition | null>(null)
  const [hasNewContent, setHasNewContent] = useState(false)
  const seen = useRef({ conversationId: '', stamp: '', ready: false, mode })
  const stamp = contentStamp(messages)
  const interruptMove = useCallback(() => {
    cancelMove.current()
    setPending(null)
  }, [])

  const attachNavigation = useCallback(
    (node: HTMLDivElement | null) => {
      const before = scroller.current
      before?.removeEventListener('wheel', interruptMove)
      before?.removeEventListener('pointerdown', interruptMove)
      before?.removeEventListener('keydown', interruptMove)
      unregister.current()
      scroller.current = node
      unregister.current = node ? registerFlowScroller(node, { seek, position }) : () => {}
      node?.addEventListener('wheel', interruptMove, { passive: true })
      node?.addEventListener('pointerdown', interruptMove, { passive: true })
      node?.addEventListener('keydown', interruptMove)
    },
    [seek, position, interruptMove],
  )

  useEffect(() => {
    const before = seen.current
    const ready = !loading && messages.length > 0
    const reset = before.conversationId !== conversationId || !before.ready || !ready
    if (reset || mode === 'follow' || before.mode === 'follow') setHasNewContent(false)
    else if (before.stamp !== stamp) setHasNewContent(true)
    seen.current = { conversationId, stamp, ready, mode }
  }, [conversationId, loading, messages.length, mode, stamp])

  const navigate = useCallback(
    (target: FlowNavigationTarget) => {
      const node = scroller.current
      if (!node) return
      cancelMove.current()
      setReturnTo(readingPosition(node))
      if (target.targetId === `flow-answer-${messages.at(-1)?.id}`) setHasNewContent(false)
      enterFree()
      setPending(target)
      revealMessage(target.messageId)
    },
    [enterFree, revealMessage, messages],
  )

  useEffect(() => {
    const onNavigate = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const value: unknown = event.detail
      if (!value || typeof value !== 'object' || !('messageId' in value)) return
      if (typeof value.messageId !== 'string') return
      if (!messages.some((message) => message.id === value.messageId)) return
      navigate({
        messageId: value.messageId,
        targetId:
          'targetId' in value && typeof value.targetId === 'string' ? value.targetId : undefined,
      })
    }
    window.addEventListener(FLOW_NAVIGATION_EVENT, onNavigate)
    return () => window.removeEventListener(FLOW_NAVIGATION_EVENT, onNavigate)
  }, [messages, navigate])

  useLayoutEffect(() => {
    const host = scroller.current
    if (!host || !pending) return
    let frame = 0
    const attempt = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        prepareFlowTarget(pending)
        const target = revealFlowTarget(host, pending)
        if (!target) return
        frame = window.requestAnimationFrame(() => {
          cancelMove.current = moveToFlowTarget(host, target, { seek, position })
          setPending(null)
        })
      })
    }
    const observer = new MutationObserver(attempt)
    observer.observe(host, { childList: true, subtree: true, attributes: true })
    attempt()
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [pending, renderedCount, seek, position])

  useEffect(() => {
    setPending(null)
    setReturnTo(null)
    return () => cancelMove.current()
  }, [conversationId])

  const returnToReading = useCallback(() => {
    const host = scroller.current
    if (!host || !returnTo) return
    cancelMove.current()
    seek(readingTop(host, returnTo))
    setReturnTo(null)
  }, [returnTo, seek])

  const loadEarlier = useCallback(
    (load: () => void) => {
      enterFree()
      load()
    },
    [enterFree],
  )

  return {
    attachNavigation,
    navigate,
    hasNewContent,
    canReturn: returnTo !== null,
    returnToReading,
    loadEarlier,
  }
}
