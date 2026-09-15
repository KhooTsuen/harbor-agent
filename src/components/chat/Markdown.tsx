import { memo, useMemo } from 'react'
import { Check } from 'lucide-react'
import type { BlockNode, ListItem } from '@/lib/markdown'
import { hasMarkdown, parseBlocks } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { CodeBlock } from './CodeBlock'
import { Inline } from './markdown/Inline'
import { Table } from './markdown/Table'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染

   解析在 lib/markdown（纯函数、有单测），这里只负责变成元素。

   两个设计取舍：
     · **不用 innerHTML** —— 模型输出不可信，拼 HTML 就是 XSS 口子。
     · **没有 Markdown 记号时走纯文本分支** —— 大多数回复是一两句话，
       整篇解析纯属浪费；这条短路在长对话里省下的时间不小。

   流式容错：解析器对「半个代码块」「只有一边的粗体标记」都能兜住，
   所以边生成边渲染不会崩也不会闪。
   ══════════════════════════════════════════════════════════════ */

const HEADING_SIZE: Record<number, string> = {
  1: 'text-xl',
  2: 'text-lg',
  3: 'text-md',
  4: 'text-base',
}

function ListItemView({
  item,
  ordered,
  index,
  start,
}: {
  item: ListItem
  ordered: boolean
  index: number
  start: number
}) {
  return (
    <li className="flex gap-2">
      {item.checked === undefined ? (
        <span className="shrink-0 select-none pt-px text-fg-tertiary">
          {ordered ? `${start + index}.` : '•'}
        </span>
      ) : (
        <span
          className={cn(
            'mt-[0.3em] flex size-[0.95em] shrink-0 items-center justify-center rounded-sm border',
            item.checked ? 'border-transparent' : 'border-line-strong',
          )}
          style={item.checked ? { background: 'var(--accent-blue)' } : undefined}
          aria-hidden
        >
          {item.checked ? <Check size={10} className="text-white" strokeWidth={3} /> : null}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <Inline nodes={item.children} />
        {item.blocks.length > 0 ? (
          <div className="mt-1">
            <BlockList blocks={item.blocks} />
          </div>
        ) : null}
      </span>
    </li>
  )
}

function BlockList({ blocks }: { blocks: BlockNode[] }) {
  return (
    <>
      {blocks.map((node, index) => {
        switch (node.type) {
          case 'code':
            return (
              <CodeBlock
                key={index}
                block={{
                  id: `md-${index}`,
                  language: node.language,
                  code: node.code,
                  filename: node.filename,
                  highlightLines: node.highlightLines,
                }}
                className="my-3"
              />
            )

          case 'heading':
            return (
              <p
                key={index}
                className={cn(
                  'mt-4 mb-1.5 font-semibold text-fg-primary',
                  HEADING_SIZE[node.level] ?? 'text-base',
                )}
              >
                <Inline nodes={node.children} />
              </p>
            )

          case 'list':
            return (
              <ul key={index} className="my-1.5 flex flex-col gap-1 pl-5">
                {node.items.map((item, itemIndex) => (
                  <ListItemView
                    key={itemIndex}
                    item={item}
                    ordered={node.ordered}
                    index={itemIndex}
                    start={node.start}
                  />
                ))}
              </ul>
            )

          case 'quote':
            return (
              <blockquote
                key={index}
                className="my-2 border-l-2 pl-3 text-fg-secondary"
                style={{ borderColor: 'var(--border-strong)' }}
              >
                <BlockList blocks={node.blocks} />
              </blockquote>
            )

          case 'table':
            return <Table key={index} align={node.align} header={node.header} rows={node.rows} />

          case 'hr':
            return <hr key={index} className="my-4 border-line-hairline" />

          default:
            return (
              <p key={index} className="my-1.5 whitespace-pre-wrap break-words">
                <Inline nodes={node.children} />
              </p>
            )
        }
      })}
    </>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  /* 没有记号就不解析，直接一段带换行的文字 —— 最常见的情况走这条 */
  const simple = useMemo(() => !hasMarkdown(text), [text])
  const blocks = useMemo(() => (simple ? [] : parseBlocks(text)), [simple, text])

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      {simple ? <p className="whitespace-pre-wrap">{text}</p> : <BlockList blocks={blocks} />}
    </div>
  )
})
