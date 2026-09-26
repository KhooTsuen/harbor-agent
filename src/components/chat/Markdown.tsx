import { memo, useMemo } from 'react'
import { parseBlocks } from '@/lib/markdown'
import { BlockList } from './markdown/Blocks'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染（写完的消息）

   块怎么变成元素在 `markdown/Blocks`，这里只是「整篇解析 + 渲染」。

   ── 和流式那套的关系 ──

   流式中由 `MessageItem` 用 `markdown/StreamingMarkdown` 渲染（增量解析 +
   稳定块不重渲，见那边的注释）；消息**写完后切到这里的整篇解析**。
   两条路的产物一致（验收 e：收尾切过来不重排），所以不会「啪」一下变样。

   ── 历史上的坑（别再犯） ──

   0.84.0 曾把流式正文整个退回纯文本（`StreamingText`，已删），因为当时
   「每次重解析全篇 → 块对象全变 → 全量重画」，看起来就是「写完一段被覆盖
   重写」。真瓶颈在**渲染**不在解析：5000 字一次解析 14ms、渲染 1574ms。
   现在靠「稳定块数组引用不变（push 不造新数组）+ memo」解决。
   ══════════════════════════════════════════════════════════════ */

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      <BlockList blocks={blocks} />
    </div>
  )
})
