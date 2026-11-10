import type { Message, Citation } from '@/types'

/** Resolve only recorded provenance in this selected execution; never guess from titles. */
export function citationTarget(message: Message, citation: Citation): string | undefined {
  if (!citation.sourceToolId || (citation.sourceExecId && citation.sourceExecId !== message.execId))
    return
  const node = message.flow?.nodes.find(
    (item) => item.kind === 'tool' && item.toolId === citation.sourceToolId,
  )
  return node ? `flow-node-${message.id}-${node.id}` : undefined
}

export function referenceTarget(message: Message, href: string): string | undefined {
  if (!href.startsWith('#')) return
  let key: string
  try {
    key = decodeURIComponent(href.slice(1))
  } catch {
    return
  }
  if (key.startsWith(`flow-node-${message.id}-`)) {
    const raw = key.slice(`flow-node-${message.id}-`.length)
    if (!/^\d+$/.test(raw)) return
    const id = Number(raw)
    return message.flow?.nodes.some((node) => node.id === id) ? key : undefined
  }
  const match = /^(?:citation|cite|source)-(.+)$/.exec(key)
  if (!match) return
  const citation =
    message.citations?.find((item) => item.id === match[1]) ??
    (/^[1-9]\d*$/.test(match[1]) ? message.citations?.[Number(match[1]) - 1] : undefined)
  return citation ? citationTarget(message, citation) : undefined
}
