import { memo } from 'react'
import { Check } from 'lucide-react'
import type { BlockNode, ListItem } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { CodeBlock } from '../CodeBlock'
import { Inline } from './Inline'
import { Table } from './Table'

/* ══════════════════════════════════════════════════════════════
   把解析出的块变成元素

   从 `Markdown.tsx` 拆出来的（那里超 300 行了），职责很清楚：
   **输入块数据、输出元素**，不持有任何状态。

   两个设计取舍：
     · **不用 innerHTML** —— 模型输出不可信，拼 HTML 就是 XSS 口子。
     · **每个块一个 memo 组件** —— 增量解析保证「已经写完的块」对象引用不变，
       所以流式时前面那几十个块在这里被 React 直接跳过。
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

/**
 * 单个块。包成 memo 是关键 —— 增量解析保证稳定块的 `node` 引用不变，
 * 所以流式时它们在这里被跳过。
 *
 * 导出是给 `Markdown.tsx` 用的：它要在**解析出块的那一刻**就把元素建好
 * 缓存起来（缓存元素对象才躲得掉每轮的「创建元素 + 比 props」）。
 */
export const Block = memo(function Block({ node }: { node: BlockNode }) {
  switch (node.type) {
    case 'code':
      return (
        <CodeBlock
          block={{
            id: 'md',
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
        <ul className="my-1.5 flex flex-col gap-1 pl-5">
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
          className="my-2 border-l-2 pl-3 text-fg-secondary"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          <BlockList blocks={node.blocks} />
        </blockquote>
      )

    case 'table':
      return <Table align={node.align} header={node.header} rows={node.rows} />

    case 'hr':
      return <hr className="my-4 border-line-hairline" />

    default:
      return (
        <p className="my-1.5 whitespace-pre-wrap break-words">
          <Inline nodes={node.children} />
        </p>
      )
  }
})

export function BlockList({ blocks }: { blocks: BlockNode[] }) {
  return (
    <>
      {blocks.map((node, index) => (
        <Block key={index} node={node} />
      ))}
    </>
  )
}
