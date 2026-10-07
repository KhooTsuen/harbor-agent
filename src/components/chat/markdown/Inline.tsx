import { Fragment } from 'react'
import type { InlineNode } from '@/lib/markdown'
import { openImageFromDom } from '@/stores/useImageLightbox'
import { MathSpan } from './MathNode'
import { RawHtmlInline } from './RawHtml'

/* ══════════════════════════════════════════════════════════════
   行内节点渲染

   全程 React 元素，**除了两处扩展**不用 dangerouslySetInnerHTML ——
   模型输出是不可信输入，拼 HTML 等于开了个 XSS 口子。两个例外：

     · 公式：KaTeX 生成的受控 HTML（我们自己拼的，不含用户片段）；
     · 原始 HTML：用户 2026-10-08 明确要求打开的口子，风险与开关见 RawHtml.tsx。
   ══════════════════════════════════════════════════════════════ */

function render(node: InlineNode, key: number) {
  switch (node.type) {
    case 'text':
      return <Fragment key={key}>{node.text}</Fragment>

    case 'code':
      return (
        <code
          key={key}
          className="rounded-sm bg-bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-fg-primary"
        >
          {node.text}
        </code>
      )

    case 'bold':
      return (
        <strong key={key} className="font-semibold text-fg-primary">
          <Inline nodes={node.children} />
        </strong>
      )

    case 'italic':
      return (
        <em key={key} className="italic">
          <Inline nodes={node.children} />
        </em>
      )

    case 'strike':
      return (
        <s key={key} className="opacity-60">
          <Inline nodes={node.children} />
        </s>
      )

    case 'link':
      return (
        /* target=_blank 会被主进程的 setWindowOpenHandler 接住，交给系统浏览器 */
        <a
          key={key}
          href={node.href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-2 transition-colors hover:opacity-80"
          style={{ color: 'var(--accent-blue)' }}
        >
          <Inline nodes={node.children} />
        </a>
      )

    case 'image':
      return (
        <img
          key={key}
          src={node.src}
          alt={node.alt}
          loading="lazy"
          data-chat-image="true"
          className="my-2 block max-h-80 max-w-full cursor-zoom-in rounded border border-line-subtle"
          onClick={() => openImageFromDom(node.src)}
        />
      )

    case 'math':
      return <MathSpan key={key} text={node.text} />

    case 'html':
      return <RawHtmlInline key={key} html={node.html} />

    case 'br':
      return <br key={key} />

    default:
      return null
  }
}

export function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => render(node, index))}</>
}
