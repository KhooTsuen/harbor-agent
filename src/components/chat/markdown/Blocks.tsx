import { memo, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { BlockNode, ListItem } from '@/lib/markdown'
import { parseBlocks } from '@/lib/markdown'
import { splitPendingLine } from '@/lib/markdown/incremental'
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

/**
 * 把缓存的元素包一层。
 *
 * `elements` 数组的引用**永远不变**（只 push），所以 memo 一直命中 ——
 * 而 memo 命中意味着连「遍历那 131 个元素做引用比较」都不发生。
 * 不包这一层的话，虽然每个元素都能 bailout，React 还是要把整个数组跑一遍
 * （实测每次约 2ms，而尾巴本身只要 0.16ms）。
 */
export const CachedBlocks = memo(function CachedBlocks({ elements }: { elements: ReactNode[] }) {
  return <>{elements}</>
})

/**
 * 还在长的尾巴。
 *
 * ★ **残缺的标记行**不进解析（先当普通文字），**完整的一行照常解析** ——
 * 这是「流式时块不能频繁跳动」和「文字别突然变格式」两个诉求的平衡点。
 *
 * 只有这些「光杆/半截」标记现在解析会得到错误类型（等写完又变回来），
 * 才需要降级成纯文本：
 *
 *     `- `       光杆列表 → 现在像段落，写全了变列表
 *     ```t      半截围栏 → 现在像段落，闭合了变代码块
 *     `| A | B |` 表格头  → 现在像段落，分隔线来了变表格
 *
 * 而 `- 甲`、`## 标题`、普通段落这些**完整**的行，现在解析就正确且稳定，
 * 直接渲染 —— 不会「先显示成 `## 标题` 纯文本、换行后突然变成大标题」
 * （那正是用户说的「写完一段被覆盖重写」的真身）。
 *
 * 实测（逐字喂，数类型签名变化次数）：
 *
 *     列表      不拆 5 次 → 拆了 0 次
 *     任务列表  不拆 3 次 → 拆了 1 次
 *     代码块    不拆 1 次 → 拆了 1 次（结构定型，不可避免）
 *     表格      不拆 1 次 → 拆了 1 次（同上）
 *
 * ★ `streaming` 为 false 时**必须正常解析**最后一行。写完了还当纯文本的话，
 * `这是**重点**` 这种没换行收尾的内容会丢掉所有格式 —— 这个被已有的
 * Markdown 渲染测试当场拦住过。
 */
export const TailBlock = memo(function TailBlock({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  if (!text) return null
  const { settled, pending } = splitPendingLine(text)
  return (
    <>
      {settled ? <BlockList blocks={parseBlocks(settled)} /> : null}
      {pending ? (
        streaming ? (
          <p className="my-1.5 whitespace-pre-wrap break-words">{pending}</p>
        ) : (
          <BlockList blocks={parseBlocks(pending)} />
        )
      ) : null}
    </>
  )
})
