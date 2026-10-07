import { memo, useEffect, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   Mermaid 图表

   ```mermaid 代码块不走 CodeBlock，改在这里渲染成 SVG。

   两个要点：
     · **动态 import** —— mermaid 有一兆多，静态引会拖垮首屏。
     · 渲染是**异步**的，所以有「正在渲染 / 出错退化成代码」两态。

   securityLevel:'strict' 让 mermaid 自己 sanitize 图里的标签 ——
   图定义同样是模型输出，别让它借图表再开一个口子。
   ══════════════════════════════════════════════════════════════ */

let seq = 0

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })
        const { svg: out } = await mermaid.render(`mermaid-${Date.now()}-${seq++}`, code)
        if (!alive) return
        setSvg(out)
        setError('')
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      alive = false
    }
  }, [code])

  if (error) {
    return (
      <pre className="my-3 overflow-x-auto whitespace-pre-wrap break-words rounded border border-line-subtle bg-bg-surface p-2 font-mono text-xs text-fg-secondary">
        {code}
      </pre>
    )
  }
  if (!svg) {
    return <div className="my-3 text-xs text-fg-tertiary">正在渲染图表…</div>
  }
  return (
    <div
      className="my-3 flex justify-center overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
})
