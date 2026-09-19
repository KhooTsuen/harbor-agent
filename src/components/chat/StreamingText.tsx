import { memo } from 'react'

/* ══════════════════════════════════════════════════════════════
   流式中的正文渲染（AG-023 之后的「重新做文本渲染」）

   ── 原则 ──

   流式中**只做「给行首标记染色」，不做任何块重排**。这是从上次的教训里
   定的铁律：块重排（把一行从段落变列表、变标题）就是「写完一段被覆盖
   重写」的根源。所以这里每行都独立渲染，行与行之间永远不合并、不重组。

   这样：
     · 流得顺（每行只是「文字变长」，结构永不变）
     · `## 标题` 不再突兀（`##` 染成浅色，标题文字保持正文色）
     · 写完最后一刻才交给 `<Markdown>` 做真正的块渲染

   ── 为什么逐行渲染 ──

   逐行 div 的好处：只有「最后一行」在流式中变化，前面的行引用不变、
   内容不变，React 直接跳过。整段塞一个 div 的话，每次文字变长都要
   重算整段的染色。

   代价是长文本会有几百个 div —— 但流式中它们大多不动，成本可控。
   ══════════════════════════════════════════════════════════════ */

/** 行首的块标记：标题 / 无序列表 / 有序列表 / 引用（后跟空白才算） */
const MARKER_RE = /^(\s*(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)\s+)/

/** 行首的围栏：```ts 或 ~~~（不要求后面有内容，它是自成一行的标记） */
const FENCE_RE = /^(\s*(?:`{3,}|~{3,})\S*)/

/** 把一行的「标记部分」和「内容部分」拆开；没有标记就整个是内容 */
export function splitLine(line: string): { marker: string; rest: string } {
  const fence = FENCE_RE.exec(line)
  if (fence) return { marker: fence[1], rest: line.slice(fence[1].length) }
  const m = MARKER_RE.exec(line)
  if (m) return { marker: m[1], rest: line.slice(m[1].length) }
  return { marker: '', rest: line }
}

/**
 * 流式中的一行。
 *
 * 标记部分用 `text-fg-tertiary`（和正文的 `text-fg-primary` 区分，浅灰），
 * 内容保持原样。空行也占一个高度，免得行号/间距跳动。
 */
const StreamLine = memo(function StreamLine({ line }: { line: string }) {
  const { marker, rest } = splitLine(line)
  return (
    <div className="min-h-[1.4em] break-words">
      {marker ? <span className="text-fg-tertiary select-none">{marker}</span> : null}
      {rest}
    </div>
  )
})

export const StreamingText = memo(function StreamingText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="text-base leading-relaxed text-fg-primary">
      {lines.map((line, index) => (
        <StreamLine key={index} line={line} />
      ))}
    </div>
  )
})
