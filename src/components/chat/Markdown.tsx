import { memo, useMemo } from 'react'
import { parseBlocks } from '@/lib/markdown'
import { BlockList } from './markdown/Blocks'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染（写完的消息）

   块怎么变成元素在 `markdown/Blocks`，这里只是「整篇解析 + 渲染」。

   ── 为什么不再有「流式增量」那一套 ──

   曾经为了「流式中实时渲染 Markdown」做过增量解析、元素缓存、拆半行，
   结果流式期间块反复重画，用户看到的就是「写完一段被覆盖重写」。
   反复试了三版都不对，最后用户点破：**流式中根本不需要解析 Markdown**，
   像思考链一样纯文本直接流就好（见 `StreamingText.tsx`）。

   所以现在 `Markdown` 只负责**写完的消息**：流式中由 `MessageItem` 直接
   用 `StreamingText` 渲染纯文本，写完后才切到 `<Markdown>` 一次性解析。
   ══════════════════════════════════════════════════════════════ */

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      <BlockList blocks={blocks} />
    </div>
  )
})
