import { createContext, useContext, type ReactNode } from 'react'
import type { Message } from '@/types'
import { referenceTarget } from '@/lib/citationTargets'
import { navigateToFlow } from '@/lib/flowNavigation'

export const FlowReferenceContext = createContext<Message | null>(null)

export function FlowReferenceLink({ href, children }: { href: string; children: ReactNode }) {
  const message = useContext(FlowReferenceContext)
  const target = message ? referenceTarget(message, href) : undefined
  const internal = /^#(?:citation-|cite-|source-|flow-node-)/.test(href)
  if (internal && !target) return <span title="这条来源没有可定位的步骤记录">{children}</span>
  return (
    <a
      href={href}
      target={target ? undefined : '_blank'}
      rel="noreferrer"
      className="underline decoration-line-strong underline-offset-2 transition-colors hover:opacity-80"
      style={{ color: 'var(--accent-blue)' }}
      onClick={
        target && message
          ? (event) => {
              event.preventDefault()
              navigateToFlow(message.id, target)
            }
          : undefined
      }
    >
      {children}
    </a>
  )
}
