import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useScrollStore } from '@/stores/useScrollStore'
import { preserveFlowAnchor } from '@/lib/flowNavigation'
import { Markdown } from '../Markdown'
import { useScrollGuard } from '../scrollGuard'
import { FlowDisclosure } from './FlowDisclosure'
import '@/styles/conversation-reasoning.css'

/** Reasoning stays secondary, with an optional full view inside the same disclosure. */
export function ReasoningBlock({
  text,
  active = false,
  count,
  memoryKey,
}: {
  text: string
  active?: boolean
  count?: number
  memoryKey?: string
}) {
  const generatedId = useId()
  const [localFull, setLocalFull] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const saved = useScrollStore((state) =>
    memoryKey ? state.processOpen[`${memoryKey}:full`] : undefined,
  )
  const full = memoryKey ? (saved ?? false) : localFull
  const host = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const restore = useRef<(() => void) | null>(null)
  const guard = useScrollGuard()
  const contentId = `reasoning-${generatedId}`
  const hasText = Boolean(text.trim())

  useLayoutEffect(() => {
    const frame = viewport.current
    const body = content.current
    if (!frame || !body) return
    const measure = () => {
      const style = getComputedStyle(frame)
      const preview = Number.parseFloat(style.getPropertyValue('--reasoning-preview-height'))
      if (body.getBoundingClientRect().height > 0 && Number.isFinite(preview)) {
        setOverflowing(body.getBoundingClientRect().height > preview + 1)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    observer.observe(body)
    return () => observer.disconnect()
  }, [hasText])

  useLayoutEffect(() => {
    restore.current?.()
    restore.current = null
  }, [full])

  if (!hasText) return null

  return (
    <FlowDisclosure
      label={
        <>
          <span>{active ? '思考过程 · 正在生成' : '思考过程'}</span>
          {count !== undefined ? <span className="reasoning-count">{count} 字</span> : null}
        </>
      }
      memoryKey={memoryKey}
      className="flow-reasoning"
    >
      <div ref={host} className="reasoning-surface">
        <div
          ref={viewport}
          id={contentId}
          className="reasoning-viewport"
          data-full={full}
          tabIndex={!full && overflowing ? 0 : undefined}
          role="region"
          aria-label="思考内容"
        >
          <div ref={content} className="reasoning-markdown">
            <Markdown text={text} />
          </div>
        </div>
        {overflowing ? (
          <button
            type="button"
            className="reasoning-expand"
            aria-controls={contentId}
            aria-expanded={full}
            onClick={() => {
              guard?.enterFree()
              if (host.current) restore.current = preserveFlowAnchor(host.current)
              if (memoryKey) useScrollStore.getState().setProcessOpen(`${memoryKey}:full`, !full)
              else setLocalFull(!full)
            }}
          >
            {full ? '收起完整思考' : '展开完整思考'}
          </button>
        ) : null}
      </div>
    </FlowDisclosure>
  )
}
