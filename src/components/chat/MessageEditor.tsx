import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   就地编辑一条用户消息

   ★ 为什么不用 `window.prompt`：**Electron 里没有 prompt()** —— 它静默返回
     null，于是「编辑」这个按钮点了等于没点（用户报的就是这个："貌似只是个
     占位按钮"）。凡是需要用户输入的地方，都得用应用自己的界面。

   ★ 为什么只有一个按钮：编辑 = 改内容 + 按新内容重新回答，两件事绑在一起。
     以前分成「保存 / 保存并重新回答」两个出口 —— 那会留下一条**按旧内容写的**
     回答（答非所问），而"只改文字"这条路几乎没人真的要。改完之后是同一条消息的
     第 N 版，想回上一版点气泡下方的 `‹ n / N ›` 就行，不用在这里给第二个按钮。

   ★ 宽度对齐下方那个输入框：同一个 `--content-max-width` 上限、同样居中。
     以前写的是 `w-full max-w-[78%]` —— 百分比落在「单行收缩」的上下文里会被当成
     auto（父层只有 max-width、没有 w-full），编辑框被压成两百来像素的窄条。
   ══════════════════════════════════════════════════════════════ */

export interface MessageEditorProps {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}

export function MessageEditor({ initial, onSave, onCancel }: MessageEditorProps) {
  const [text, setText] = useState(initial)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  /*
   * 跟着内容长高。
   *
   * ★ textarea 的 `rows` 数的是**换行符**，不是折行后的行数 —— 一条很长的单行消息
   *   只会给 2 行高，剩下的在里面滚动，用户根本看不到"它已经换行了"（这正是
   *   "输入到上限宽度不换行"那个报障的来源）。所以这里按 scrollHeight 设高度，
   *   顶到 320px 左右就改成内部滚动。
   */
  const fitHeight = (): void => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }

  /* 进来就聚焦，光标放末尾 —— 大多数人是要接着改，不是全选删掉 */
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    fitHeight()
  }, [])

  const trimmed = text.trim()

  return (
    <div
      className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col gap-2"
      data-message-editor="true"
    >
      <textarea
        ref={areaRef}
        value={text}
        rows={2}
        aria-label="编辑这条消息"
        onChange={(event) => {
          setText(event.target.value)
          fitHeight()
        }}
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
        className="w-full resize-y break-words rounded-md border bg-bg-input px-3.5 py-2 text-base leading-relaxed text-fg-primary outline-none"
      />

      <div className="flex flex-col items-end gap-1">
        <p className="text-2xs text-fg-tertiary">
          保存后会用新内容重新回答；改过的消息可以点下方 ‹ › 在几版之间切换
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-2xs text-fg-tertiary">Esc 取消 · Ctrl+Enter 保存</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={!trimmed} onClick={() => onSave(trimmed)}>
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}
