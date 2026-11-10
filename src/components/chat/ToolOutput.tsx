import { useLayoutEffect, useRef, useState } from 'react'
import { useScrollGuard } from './scrollGuard'
import '@/styles/conversation-tools.css'

/** 日志只在用户仍位于底部时跟随；向上阅读时不改其位置。 */
export function ToolOutput({ text, motion = false }: { text: string; motion?: boolean }) {
  const output = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  const previous = useRef(text)
  const [unread, setUnread] = useState(false)
  const guard = useScrollGuard()

  useLayoutEffect(() => {
    const element = output.current
    if (!element) return
    if (following.current) element.scrollTop = element.scrollHeight
    else if (previous.current !== text) setUnread(true)
    previous.current = text
  }, [text])

  return (
    <div className="flow-tool-output" data-tool-motion={motion || undefined}>
      <pre
        ref={output}
        tabIndex={0}
        aria-label="工具原始输出"
        onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12
          if (following.current) setUnread(false)
          else guard?.enterFree()
        }}
        className="flow-tool-log"
      >
        {text}
      </pre>
      {unread ? (
        <button
          type="button"
          className="flow-tool-new-output"
          onClick={() => {
            following.current = true
            if (output.current) output.current.scrollTop = output.current.scrollHeight
            setUnread(false)
          }}
        >
          有新输出 · 查看底部
        </button>
      ) : null}
    </div>
  )
}
