import { memo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/* ══════════════════════════════════════════════════════════════
   数学公式渲染（KaTeX）

   输入是解析层给的**原文**（不含两侧 $），这里只管：
     · renderToString 拿到静态 HTML
     · throwOnError:false —— 写坏了显示成红色原文，不炸掉整条消息
   解析失败/异常时退回等宽原文，读者至少能看到自己写的是什么。
   ══════════════════════════════════════════════════════════════ */

function render(text: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(text, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: false,
    })
  } catch {
    return null
  }
}

/** 行内公式 $…$ */
export const MathSpan = memo(function MathSpan({ text }: { text: string }) {
  const html = render(text, false)
  if (!html) {
    return (
      <code className="rounded-sm bg-bg-raised px-1 py-0.5 font-mono text-[0.9em]">{`$${text}$`}</code>
    )
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />
})

/** 块级公式 $$…$$ */
export const MathBlock = memo(function MathBlock({ text }: { text: string }) {
  const html = render(text, true)
  if (!html) {
    return (
      <pre className="my-3 overflow-x-auto rounded border border-line-subtle bg-bg-surface p-2 font-mono text-xs text-fg-secondary">
        {text}
      </pre>
    )
  }
  return (
    <div className="my-3 overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: html }} />
  )
})
