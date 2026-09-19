import { Check, Copy, Download, Hash, WrapText } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   CodeBlock 的标题栏

   左边：语言标签（```js → JavaScript）/ 文件名。
   右边：换行、行号、下载、复制。平时淡出，鼠标进来才亮 ——
        一排按钮常驻会把代码区压得很吵。
   ══════════════════════════════════════════════════════════════ */

export interface CodeHeaderProps {
  label: string
  filename?: string
  wrap: boolean
  numbers: boolean
  copied: boolean
  onToggleWrap: () => void
  onToggleNumbers: () => void
  onCopy: () => void
  onDownload: () => void
}

export function CodeHeader({
  label,
  filename,
  wrap,
  numbers,
  copied,
  onToggleWrap,
  onToggleNumbers,
  onCopy,
  onDownload,
}: CodeHeaderProps) {
  return (
    <div className="flex items-center gap-2 border-b border-line-subtle px-2 py-1">
      {filename ? (
        <>
          <span className="truncate font-mono text-2xs text-fg-secondary" title={filename}>
            {filename}
          </span>
          <span className="shrink-0 font-mono text-2xs uppercase tracking-wide text-fg-tertiary">
            {label}
          </span>
        </>
      ) : (
        <span className="font-mono text-2xs uppercase tracking-wide text-fg-tertiary">{label}</span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconButton
          label={wrap ? '取消自动换行' : '自动换行'}
          size={28}
          active={wrap}
          onClick={onToggleWrap}
        >
          <WrapText size={13} />
        </IconButton>
        <IconButton
          label={numbers ? '隐藏行号' : '显示行号'}
          size={28}
          active={numbers}
          onClick={onToggleNumbers}
        >
          <Hash size={13} />
        </IconButton>
        <IconButton label="下载代码" size={28} onClick={onDownload}>
          <Download size={13} />
        </IconButton>
        <IconButton label={copied ? '已复制' : '复制代码'} size={28} onClick={onCopy}>
          {copied ? (
            <Check size={13} style={{ color: colorOf('completed') }} />
          ) : (
            <Copy size={13} />
          )}
        </IconButton>
      </div>
    </div>
  )
}
