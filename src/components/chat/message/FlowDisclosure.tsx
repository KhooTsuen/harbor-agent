import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useScrollStore } from '@/stores/useScrollStore'
import { useScrollGuard } from '../scrollGuard'
import '@/styles/conversation-flow.css'

/** Native details keep their contents and selection mounted when the user folds a step. */
export function FlowDisclosure({
  label,
  children,
  defaultOpen = false,
  live = false,
  className = '',
  id,
  memoryKey,
  onToggle,
}: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  live?: boolean
  className?: string
  id?: string
  memoryKey?: string
  onToggle?: (open: boolean) => void
}) {
  const generatedId = useId()
  const [manual, setManual] = useState<boolean | null>(null)
  const saved = useScrollStore((state) => (memoryKey ? state.processOpen[memoryKey] : undefined))
  const guard = useScrollGuard()
  const open = memoryKey ? (saved ?? defaultOpen) : (manual ?? defaultOpen)
  return (
    <details
      id={id ?? generatedId}
      open={open}
      className={`flow-disclosure ${className}`}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next === open) return
        setManual(next)
        if (memoryKey) useScrollStore.getState().setProcessOpen(memoryKey, next)
        onToggle?.(next)
      }}
    >
      <summary
        className="flow-disclosure-trigger"
        onClick={() => guard?.enterFree()}
        aria-expanded={open}
      >
        <ChevronRight size={12} className="flow-disclosure-chevron" aria-hidden="true" />
        <span className={live ? 'flow-running-label' : undefined}>{label}</span>
      </summary>
      <div className="flow-disclosure-content">{children}</div>
    </details>
  )
}
