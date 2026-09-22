import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   就地编辑一条用户消息

   ★ 为什么不用 `window.prompt`：**Electron 里没有 prompt()** —— 它静默返回
     null，于是「编辑」这个按钮点了等于没点（用户报的就是这个："貌似只是个
     占位按钮"）。凡是需要用户输入的地方，都得用应用自己的界面。

   两个出口，因为「只改文字」和「改完重新问」是两件不同的事：

   · 保存 —— 只改这条的文字。后面那条回复还是按**旧问题**写的，所以当后面
     还有消息时，界面上要说明这一点（不说的话用户会以为回答变了）。
   · 保存并重新回答 —— 丢掉这条之后的所有消息，用新文字重发。这是大多数人
     点「编辑」时真正想要的，所以放在主按钮位；只在后面确实有内容时才出现。
   ══════════════════════════════════════════════════════════════ */

export interface MessageEditorProps {
  initial: string
  /** 这条后面还有没有别的消息（决定要不要给「重新回答」这个出口） */
  hasLater: boolean
  onSave: (text: string) => void
  onSaveAndResend: (text: string) => void
  onCancel: () => void
}

export function MessageEditor({
  initial,
  hasLater,
  onSave,
  onSaveAndResend,
  onCancel,
}: MessageEditorProps) {
  const [text, setText] = useState(initial)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  /* 进来就聚焦，光标放末尾 —— 大多数人是要接着改，不是全选删掉 */
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const trimmed = text.trim()
  const lines = text.split('\n').length

  return (
    <div className="flex w-full max-w-[78%] flex-col items-end gap-2" data-message-editor="true">
      <textarea
        ref={areaRef}
        value={text}
        rows={Math.min(12, Math.max(2, lines))}
        aria-label="编辑这条消息"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && trimmed) {
            event.preventDefault()
            onSave(trimmed)
          }
        }}
        className="w-full resize-y rounded-md rounded-br-sm border bg-bg-raised px-3.5 py-2 text-base leading-relaxed text-fg-primary outline-none"
      />

      <div className="flex flex-col items-end gap-1">
        {hasLater ? (
          <p className="text-2xs text-fg-tertiary">
            后面的回复是按旧问题写的 ——「保存并重新回答」会把它们丢掉重来
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-2xs text-fg-tertiary">Esc 取消 · Ctrl+Enter 保存</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" variant="secondary" disabled={!trimmed} onClick={() => onSave(trimmed)}>
            保存
          </Button>
          {hasLater ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!trimmed}
              onClick={() => onSaveAndResend(trimmed)}
            >
              保存并重新回答
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
