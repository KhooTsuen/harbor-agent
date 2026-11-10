import { useLayoutEffect, useRef, useState } from 'react'
import type { FlowNode } from '@/lib/conversationFlow'
import type { ToolRunRecord } from '@/types'
import { FLOW_NAVIGATION_EVENT, FLOW_REVEAL_EVENT, preserveFlowAnchor } from '@/lib/flowNavigation'
import { useScrollGuard } from '../scrollGuard'
import { Markdown } from '../Markdown'
import { ToolLine } from './ToolLine'
import { ReasoningBlock } from './ReasoningBlock'

type ProcessItem = { id: number; nodes: FlowNode[]; runs?: ToolRunRecord[] }

/** Only adjacent tool nodes aggregate; text and reasoning keep their original place. */
function groupSteps(nodes: FlowNode[], runs: Map<string, ToolRunRecord>): ProcessItem[] {
  const items: ProcessItem[] = []
  for (const node of nodes) {
    const last = items.at(-1)
    const run = node.kind === 'tool' ? runs.get(node.toolId) : undefined
    if (node.kind === 'tool' && last?.runs && last.nodes.at(-1)?.id === node.id - 1) {
      last.nodes.push(node)
      if (run) last.runs.push(run)
    } else
      items.push({
        id: node.id,
        nodes: [node],
        ...(node.kind === 'tool' ? { runs: run ? [run] : [] } : {}),
      })
  }
  return items
}

export function FlowProcessSteps({
  nodes,
  runs,
  activeId,
  motion,
  streaming,
  expanded,
  memoryKey,
  messageId,
}: {
  nodes: FlowNode[]
  runs: Map<string, ToolRunRecord>
  activeId?: number
  motion: boolean
  streaming: boolean
  expanded: boolean
  memoryKey: string
  messageId: string
}) {
  const [limit, setLimit] = useState(40)
  const [readingStart, setReadingStart] = useState<number | null>(null)
  const [navigationTarget, setNavigationTarget] = useState<number | null>(null)
  const [markerTop, setMarkerTop] = useState<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const restore = useRef<(() => void) | null>(null)
  const guard = useScrollGuard()
  const items = groupSteps(nodes, runs)
  const hidden =
    expanded && readingStart !== null ? readingStart : Math.max(0, items.length - limit)
  const visible = items.slice(hidden)
  const current = items.find((item) => item.nodes.some((node) => node.id === activeId))?.id
  useLayoutEffect(() => {
    if (expanded) setReadingStart((value) => value ?? Math.max(0, items.length - limit))
    else setReadingStart(null)
  }, [expanded, items.length, limit])
  useLayoutEffect(() => {
    const onNavigate = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const value: unknown = event.detail
      if (
        !value ||
        typeof value !== 'object' ||
        !('messageId' in value) ||
        value.messageId !== messageId
      )
        return
      if (!('targetId' in value) || typeof value.targetId !== 'string') return
      const prefix = `flow-node-${messageId}-`
      if (!value.targetId.startsWith(prefix)) return
      const raw = value.targetId.slice(prefix.length)
      if (!/^\d+$/.test(raw)) return
      const nodeId = Number(raw)
      const at = items.findIndex((item) => item.nodes.some((node) => node.id === nodeId))
      if (at < 0) return
      setLimit((value) => Math.max(value, items.length - at))
      setReadingStart((value) => Math.min(value ?? at, at))
      setNavigationTarget(nodeId)
    }
    window.addEventListener(FLOW_NAVIGATION_EVENT, onNavigate)
    window.addEventListener(FLOW_REVEAL_EVENT, onNavigate)
    return () => {
      window.removeEventListener(FLOW_NAVIGATION_EVENT, onNavigate)
      window.removeEventListener(FLOW_REVEAL_EVENT, onNavigate)
    }
  }, [items, messageId])
  useLayoutEffect(() => {
    const element = host.current
    if (!element || navigationTarget === null) return
    const group = items.find((item) => item.nodes.some((node) => node.id === navigationTarget))
    if (!group) return
    let parent = element.parentElement
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
      parent = parent.parentElement
    }
    const reveal = () => {
      if (document.getElementById(`flow-node-${messageId}-${navigationTarget}`)) return true
      const row = element.querySelector<HTMLElement>(`[data-flow-step="${group.id}"]`)
      const button = row?.querySelector<HTMLButtonElement>(
        '.flow-tool-group > button[aria-controls]',
      )
      if (button?.getAttribute('aria-expanded') === 'false') button.click()
      else row?.querySelector<HTMLButtonElement>('.flow-tool-load-earlier')?.click()
      return false
    }
    if (reveal()) {
      setNavigationTarget(null)
      return
    }
    const observer = new MutationObserver(() => {
      if (reveal()) {
        observer.disconnect()
        setNavigationTarget(null)
      }
    })
    observer.observe(element, { childList: true, subtree: true, attributes: true })
    return () => observer.disconnect()
  }, [navigationTarget, limit, items, messageId])
  useLayoutEffect(() => {
    restore.current?.()
    restore.current = null
  }, [limit])
  useLayoutEffect(() => {
    const element = host.current
    if (!element || current === undefined) {
      setMarkerTop(null)
      return
    }
    const measure = () => {
      const row = element.querySelector<HTMLElement>(`[data-flow-step="${current}"]`)
      setMarkerTop(row ? row.offsetTop + 12 : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [current, hidden])
  return (
    <div ref={host} className="flow-steps" data-flow-process="true">
      {markerTop !== null ? (
        <span className="flow-step-marker" style={{ top: markerTop }} aria-hidden="true" />
      ) : null}
      {hidden > 0 ? (
        <button
          type="button"
          className="flow-load-steps"
          onClick={() => {
            guard?.enterFree()
            const anchor = host.current?.querySelector<HTMLElement>('[data-flow-step]')
            if (anchor) restore.current = preserveFlowAnchor(anchor)
            setLimit((value) => value + 50)
            setReadingStart((value) => Math.max(0, (value ?? hidden) - 50))
          }}
        >
          加载更早的 {Math.min(50, hidden)} 组步骤（还有 {hidden} 组）
        </button>
      ) : null}
      {visible.map((item) => {
        const node = item.nodes[0]
        const active = item.id === current
        return (
          <div
            key={item.id}
            className="flow-step"
            data-flow-step={item.id}
            data-flow-node={node.id}
            id={item.runs ? undefined : `flow-node-${messageId}-${node.id}`}
            data-current={active || undefined}
          >
            {item.runs
              ? item.nodes.map((entry) =>
                  entry.kind === 'tool' && !runs.has(entry.toolId) ? (
                    <span
                      key={entry.id}
                      id={`flow-node-${messageId}-${entry.id}`}
                      aria-hidden="true"
                    />
                  ) : null,
                )
              : null}
            {item.runs ? (
              item.runs.length ? (
                <ToolLine
                  runs={item.runs}
                  motion={motion}
                  hideMeta={streaming}
                  anchorIds={Object.fromEntries(
                    item.nodes.flatMap((node) =>
                      node.kind === 'tool'
                        ? [[node.toolId, `flow-node-${messageId}-${node.id}`]]
                        : [],
                    ),
                  )}
                />
              ) : (
                <span className="flow-unknown-tool">工具记录尚未到达</span>
              )
            ) : node.kind === 'reasoning' ? (
              <ReasoningBlock
                text={node.text}
                active={streaming && active}
                memoryKey={`${memoryKey}:reasoning:${node.id}`}
              />
            ) : node.kind === 'speech' && node.text ? (
              <div className="flow-process-speech">
                <Markdown text={node.text} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
