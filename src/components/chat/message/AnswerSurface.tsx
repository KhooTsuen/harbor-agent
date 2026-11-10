import { createContext, useContext, useRef } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { Message } from '@/types'
import '@/styles/conversation-answer.css'
import { FlowReferenceContext } from './FlowReference'

const AnswerMotionContext = createContext(false)
export const useAnswerMotion = () => useContext(AnswerMotionContext)

/** Opening history stays static; only an execution observed live enables arrivals. */
export function AnswerSurface({ message, children }: { message: Message; children: ReactNode }) {
  const execution = message.execId ?? `answer-${message.answerIndex ?? 0}`
  const observedLive = useRef(new Set<string>())
  if (message.status === 'streaming') observedLive.current.add(execution)
  return (
    <AnswerMotionContext.Provider value={observedLive.current.has(execution)}>
      <FlowReferenceContext.Provider value={message}>
        <div className="flow-answer-surface w-full max-w-[86ch]">{children}</div>
      </FlowReferenceContext.Provider>
    </AnswerMotionContext.Provider>
  )
}

type AnswerTransition = {
  skipTransition: () => void
  finished: Promise<void>
  ready?: Promise<void>
  updateCallbackDone?: Promise<void>
}
type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => AnswerTransition
}
let transition: AnswerTransition | null = null
let transitionSurface: HTMLElement | null = null
let selection = 0

/** One atomic store selection; a rapid second click cancels the visual delay. */
export function selectAnswerWithTransition(messageId: string, commit: () => void): void {
  const current = ++selection
  if (transition) {
    transition.skipTransition()
    transitionSurface?.style.removeProperty('view-transition-name')
    transition = null
    transitionSurface = null
    flushSync(commit)
    return
  }
  if (
    document.documentElement.dataset.animations === 'off' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    commit()
    return
  }
  const doc = document as TransitionDocument
  const article = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
  const surface = article?.querySelector<HTMLElement>('.flow-answer-surface')
  if (doc.startViewTransition && surface) {
    const name = `harbor-answer-selection-${current}`
    surface.style.setProperty('view-transition-name', name)
    const next = doc.startViewTransition(() => {
      if (selection === current) flushSync(commit)
    })
    transition = next
    transitionSurface = surface
    void next.ready?.catch(() => undefined)
    void next.updateCallbackDone?.catch(() => undefined)
    void next.finished
      .catch(() => undefined)
      .then(() => {
        if (surface.style.getPropertyValue('view-transition-name') === name) {
          surface.style.removeProperty('view-transition-name')
        }
        if (transition === next) {
          transition = null
          transitionSurface = null
        }
      })
    return
  }
  commit()
  surface?.animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
}
