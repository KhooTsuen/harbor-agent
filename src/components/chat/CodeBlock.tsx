import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { CodeBlock as CodeBlockModel } from '@/types'
import { cn } from '@/lib/utils'
import { languageName } from '@/lib/highlight'
import { saveText } from '@/lib/backend'
import { CodeBody } from './codeblock/Body'
import { CodeHeader } from './codeblock/Header'
import { gutterWidth, splitTokens } from './codeblock/lines'

/* ══════════════════════════════════════════════════════════════
   CodeBlock

   比上一版多出的东西：
     · 折叠 —— 一次贴 200 行的时候，不折的话整条消息就没法看了
     · 下载 —— 复制到剪贴板对长代码不友好
     · 行号开关、行强调（```ts {1,3-5}）、diff 行底色
     · 语言显示名（```js 显示成 JavaScript）

   没做的：点击行复制、括号配对着色、minimap。前两个成本高收益低，
   第三个在这个尺寸的界面上纯属噪音。
   ══════════════════════════════════════════════════════════════ */

/** 超过这个行数就默认折叠 */
const FOLD_THRESHOLD = 40
/** 折叠时露出的行数 */
const FOLD_PREVIEW = 24

export interface CodeBlockProps {
  block: CodeBlockModel
  /** 是否默认显示行号 */
  showLineNumbers?: boolean
  /** 更小一号字（右侧文件预览用） */
  dense?: boolean
  className?: string
}

export function CodeBlock({
  block,
  showLineNumbers = true,
  dense = false,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [numbers, setNumbers] = useState(showLineNumbers)
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => splitTokens(block.code, block.language), [block.code, block.language])

  const foldable = lines.length > FOLD_THRESHOLD
  const visible = foldable && !expanded ? lines.slice(0, FOLD_PREVIEW) : lines
  const gutter = gutterWidth(lines.length)
  const label = languageName(block.language)

  /* diff 的行号没意义（旧文件新文件两套编号），派生一个显示用的开关 */
  const isDiff = lines[0]?.[0]?.kind === 'addition' || lines[0]?.[0]?.kind === 'deletion'
  const showGutter = numbers && !isDiff

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(block.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* 剪贴板被拒（非 https / 无权限）时静默失败，不打断阅读 */
    }
  }

  function download(): void {
    const ext = /^[a-z0-9+#-]+$/i.test(block.language) && block.language ? block.language : 'txt'
    const name = block.filename ?? `snippet.${ext}`
    void saveText(name, block.code)
  }

  return (
    <div
      className={cn(
        'group overflow-hidden rounded border border-line-subtle bg-bg-surface',
        className,
      )}
    >
      <CodeHeader
        label={label}
        filename={block.filename}
        wrap={wrap}
        numbers={showGutter}
        copied={copied}
        onToggleWrap={() => setWrap((value) => !value)}
        onToggleNumbers={() => setNumbers((value) => !value)}
        onCopy={() => void copy()}
        onDownload={download}
      />

      <CodeBody
        lines={visible}
        numbers={showGutter}
        wrap={wrap}
        highlightLines={block.highlightLines}
        gutter={gutter}
        dense={dense}
      />

      {foldable ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-center gap-1 border-t border-line-subtle py-1 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> 收起
            </>
          ) : (
            <>
              <ChevronDown size={12} /> 展开其余 {lines.length - FOLD_PREVIEW} 行（共 {lines.length}{' '}
              行）
            </>
          )}
        </button>
      ) : null}
    </div>
  )
}
