import { useEffect, useRef, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   useTypewriter —— 逐字显示，可中断

   传 0 的 charsPerTick 表示一次性显示（等价于关闭打字机）。
   ══════════════════════════════════════════════════════════════ */

export function useTypewriter(text: string, enabled: boolean, charsPerTick = 2): string {
  const [shown, setShown] = useState(enabled ? '' : text)
  const indexRef = useRef(enabled ? 0 : text.length)

  useEffect(() => {
    if (!enabled) {
      setShown(text)
      indexRef.current = text.length
      return
    }
    indexRef.current = 0
    setShown('')
    const timer = window.setInterval(() => {
      indexRef.current = Math.min(indexRef.current + charsPerTick, text.length)
      setShown(text.slice(0, indexRef.current))
      if (indexRef.current >= text.length) window.clearInterval(timer)
    }, 24)
    return () => window.clearInterval(timer)
  }, [text, enabled, charsPerTick])

  return shown
}
