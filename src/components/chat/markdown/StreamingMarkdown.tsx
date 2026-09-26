import { memo, useMemo, useRef } from 'react'
import type { BlockNode } from '@/lib/markdown'
import { parseBlocks } from '@/lib/markdown'
import { EMPTY_CACHE, parseIncremental, splitPendingLine, type StableCache } from '@/lib/markdown'
import { Block } from './Blocks'

/* ══════════════════════════════════════════════════════════════
   流式中的正文渲染（实时 Markdown）

   0.84.0 曾经把流式正文改成「像思考链那样纯文本直接流」，因为实时解析
   会让块反复重画。但瓶颈其实不在解析：5000 字一次性，解析 14ms、
   **渲染 1574ms** —— 而重画来自「每次重解析整篇 → 块对象全变 → 全量重渲」。

   所以这一版把两件事分开：

     · **稳定块**（空行之后、不会再变的那些）：解析结果 push 进一个 ref 数组，
       数组引用**永不变**；渲染它们的 `StableBlocks` 是 memo 的，只有
       刚追加了新块（version 变了）时才重渲。块的 `node` 引用不变，
       内部每个 `Block` 也是 memo 的 → React 直接跳过。
     · **尾巴**（最后一个块之后还在长的部分）：每次重渲，但它短
       （完整行进块解析，残缺的半行当纯文本 —— 见 `pending.ts`）。

   为什么不造 `[...old, new]` 新数组：数组引用一变，memo 全废 ——
   那就退回「每批全量重渲」了。追加用 `push`，重渲靠 version 这个显式信号。
   ══════════════════════════════════════════════════════════════ */

/**
 * 稳定块列表。
 *
 * - `blocks` 是**同一个数组对象**（push 追加），所以 memo 不会因为内容变化而重渲；
 * - `version`（= 已稳定块数）在追加后变化 → memo 放行 → 新块出现。
 */
export const StableBlocks = memo(function StableBlocks({
  blocks,
  version,
}: {
  blocks: readonly BlockNode[]
  version: number
}) {
  /* version 只用来让 memo 放行，自己不进渲染 */
  void version

  return (
    <>
      {blocks.map((node, index) => (
        <Block key={`${index}-${node.type}`} node={node} />
      ))}
    </>
  )
})

/**
 * 尾巴：最后一个稳定块之后、还在长的部分。
 *
 * 每次重渲（内容短，开销可控）。`contain: layout` 把内部布局变化关在盒子里，
 * 不让它影响外部排版 —— 这也是「不跳」的一半原因。
 */
export function TailBlock({ text }: { text: string }) {
  if (!text) return null
  const { settled, pending } = splitPendingLine(text)
  const blocks = settled ? parseBlocks(settled) : []

  return (
    <>
      {blocks.map((node, index) => (
        <Block key={`${index}-${node.type}`} node={node} />
      ))}
      {/*
       * 只在「还有半行没写完」时才加这层盒：contain 把它的布局变化关在内部，
       * 不影响外部排版。那一行写完盒就消失 —— 所以**收尾后的 DOM 与整篇解析
       * 完全一致**（验收 e：切到 <Markdown> 不重排）。
       */}
      {pending ? (
        <div style={{ contain: 'layout' }}>
          {/* 残缺的半行不解析，直接纯文本 —— 避免「先像段落、写完变列表」的横跳 */}
          <p className="my-1.5 whitespace-pre-wrap break-words">{pending}</p>
        </div>
      ) : null}
    </>
  )
}

/**
 * 流式正文入口。写完的消息仍然走 `Markdown`（整篇解析，一次到位）。
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const cacheRef = useRef<StableCache>(EMPTY_CACHE)
  /*
   * 解析放在 render 里：增量解析只碰「新增的稳定段 + 尾巴」，
   * 流式每批几十字，代价可以忽略（5000 字一次性也才 14ms）。
   * 结果写回 ref 里的 cache —— 数组是 push 追加的，引用不变。
   */
  const parsed = useMemo(() => parseIncremental(text, cacheRef.current), [text])
  cacheRef.current = parsed.cache

  const blocks = parsed.cache.blocks

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      <StableBlocks blocks={blocks} version={blocks.length} />
      <TailBlock text={parsed.tailText} />
    </div>
  )
})
