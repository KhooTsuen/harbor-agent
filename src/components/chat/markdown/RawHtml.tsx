import { memo } from 'react'

/* ══════════════════════════════════════════════════════════════
   原始 HTML 直通

   ⚠️ 这里**故意**用 dangerouslySetInnerHTML：两处文件头（`Inline.tsx`、
   `Blocks.tsx`）一直写着「不用 innerHTML，模型输出不可信」。2026-10-08 用户
   明确要求打开这个口子，理由是「后来的使用者直接写 HTML 就能出效果」。

   代价要说清楚：模型输出、以及它读到的网页/仓库/工具输出，都可能藏攻击载荷。
   直通之后 `<iframe>` 会加载外链、`onerror=` 会触发、`<img src=x onerror=…>`
   就是一枚真的脚本。（`<script>` 标签经 innerHTML 插入不会执行 —— 浏览器规范
   如此 —— 但上面那些照样能跑。）

   ── 怎么关 ──
   `harbor.rawHtml = '0'`（localStorage），或把 DEFAULT_ENABLED 改 false。
   关掉后退化成纯文本展示，其余功能不受影响。
   ══════════════════════════════════════════════════════════════ */

const DEFAULT_ENABLED = true

export function isRawHtmlEnabled(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem('harbor.rawHtml')
    return stored === null || stored === undefined ? DEFAULT_ENABLED : stored !== '0'
  } catch {
    /* 无 localStorage（SSR/测试环境）→ 用默认 */
    return DEFAULT_ENABLED
  }
}

/** 行内 HTML 片段 */
export const RawHtmlInline = memo(function RawHtmlInline({ html }: { html: string }) {
  if (!isRawHtmlEnabled()) return <>{html}</>
  return <span dangerouslySetInnerHTML={{ __html: html }} />
})

/** 整块 HTML */
export const RawHtmlBlock = memo(function RawHtmlBlock({ html }: { html: string }) {
  if (!isRawHtmlEnabled()) {
    return (
      <pre className="my-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-line-subtle bg-bg-surface p-2 font-mono text-xs text-fg-secondary">
        {html}
      </pre>
    )
  }
  return <div className="my-2" dangerouslySetInnerHTML={{ __html: html }} />
})
