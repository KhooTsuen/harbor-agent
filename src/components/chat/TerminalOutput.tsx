import { cn } from '@/lib/utils'
import type { TerminalLine } from '@/types'

/* ══════════════════════════════════════════════════════════════
   TerminalOutput —— 纯展示的终端输出

   行首的提示符是 `❯`，跟真终端拉开一点距离，避免和正文混淆。
   ══════════════════════════════════════════════════════════════ */

export interface TerminalOutputProps {
  lines: readonly TerminalLine[]
  className?: string
  /** 显示右侧的光标（正在跑的时候） */
  showCaret?: boolean
  /** 空的时候显示什么 */
  emptyText?: string
}

const LINE_COLOR: Record<TerminalLine['type'], string> = {
  input: 'var(--text-primary)',
  output: 'var(--text-secondary)',
  error: 'var(--danger)',
  info: 'var(--text-tertiary)',
}

export function TerminalOutput({
  lines,
  className,
  showCaret = false,
  emptyText = '（暂无输出）',
}: TerminalOutputProps) {
  return (
    <div
      className={cn(
        'overflow-auto rounded border border-line-subtle bg-bg-base/60 px-3 py-2',
        'font-mono text-xs leading-[1.7]',
        className,
      )}
    >
      {lines.length === 0 ? (
        <p className="text-fg-tertiary">{emptyText}</p>
      ) : (
        lines.map((line) => (
          <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 select-none text-fg-tertiary">
              {line.type === 'input' ? '❯' : ' '}
            </span>
            <span style={{ color: LINE_COLOR[line.type] }}>{line.content}</span>
          </div>
        ))
      )}
      {showCaret ? (
        <div className="flex gap-2">
          <span className="shrink-0 select-none text-fg-tertiary">❯</span>
          <span className="caret" />
        </div>
      ) : null}
    </div>
  )
}
