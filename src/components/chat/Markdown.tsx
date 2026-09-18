import { memo, useRef } from 'react'
import { Check } from 'lucide-react'
import type { BlockNode, ListItem } from '@/lib/markdown'
import { parseBlocks } from '@/lib/markdown'
import { EMPTY_CACHE, parseIncremental, type StableCache } from '@/lib/markdown/incremental'
import { cn } from '@/lib/utils'
import { CodeBlock } from './CodeBlock'
import { Inline } from './markdown/Inline'
import { Table } from './markdown/Table'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染

   解析在 lib/markdown（纯函数、有单测），这里只负责变成元素。

   两个设计取舍：
     · **不用 innerHTML** —— 模型输出不可信，拼 HTML 就是 XSS 口子。

   ── AG-021：流式下只解析尾巴 ──

   以前是每次拿到新文本就把**全文**重解析一遍（`hasMarkdown` + `parseBlocks`），
   实测 20000 字的回复在一次流式里要在主线程累计花掉 2.6 秒。

   现在用 `parseIncremental`：只重解析「还在长的尾块」，前面已经写完的块直接复用。
   同一个场景 2607ms → 32ms（20000 字）。配合下面 `Block` 的 memo，
   稳定块的**引用不变** → React 直接跳过，连元素树也不用重建。

   原来那个「没有 Markdown 记号就走纯文本」的短路去掉了 —— 增量解析本身就是
   只算尾巴，为这种情况省下的时间已经很小，不值得多一条分支。
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
 * 单个块。
 *
 * AG-021：包成 memo 是关键 —— 增量解析保证「已经写完的块」**对象引用不变**，
 * 所以流式时前面那几十个块在这里被 React 直接跳过，连元素树都不重建。
 */
const Block = memo(function Block({ node }: { node: BlockNode }) {
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

function BlockList({ blocks }: { blocks: BlockNode[] }) {
  return (
    <>
      {blocks.map((node, index) => (
        <Block key={index} node={node} />
      ))}
    </>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  /*
   * 用 ref 缓存「上一次的文本 + 解析结果」，而不是 useMemo：
   * 解析结果里带着**跨渲染的增量状态**（已扫描到哪、已解析出哪些稳定块），
   * 这东西必须真的存住，不能靠 useMemo 的缓存策略（它允许丢弃重算）。
   *
   * 写在 render 里是安全的：只在 `text` 变了才重算，而且同一个 `text`
   * 重复调用完全幂等（StrictMode 的双调用也走这个路径）。
   */
  const cache = useRef<{
    text: string
    stable: StableCache
    tailText: string
  } | null>(null)
  if (!cache.current || cache.current.text !== text) {
    const result = parseIncremental(text, cache.current?.stable ?? EMPTY_CACHE)
    cache.current = { text, stable: result.cache, tailText: result.tailText }
  }

  const { stable, tailText } = cache.current

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      {/*
       * 稳定块 + 尾巴拼在一起渲染就够了。
       *
       * 这里**试过**再拆成「稳定块子树 + 尾巴」两个组件（想让 memo 跳过
       * 整棵子树），实测没有可测量的收益：`Block` 已经 memo 了，`BlockList`
       * 遍历那些元素本身很便宜（5000 字 416 次更新：1.92ms/次 vs 2.05ms/次）。
       * 没测出收益的复杂度就不留。
       */}
      <BlockList blocks={[...stable.blocks, ...parseBlocks(tailText)]} />
    </div>
  )
})
