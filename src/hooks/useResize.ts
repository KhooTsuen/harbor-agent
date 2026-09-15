import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   useResize —— 拖拽调宽

   用 pointer 事件（自动处理指针离开窗口），拖拽期间锁 body 光标。
   ══════════════════════════════════════════════════════════════ */

export interface ResizeOptions {
  min: number
  max: number
  /** 手柄在容器哪一侧：right 表示「向右拖变宽」 */
  side: 'left' | 'right'
  onCommit?: (value: number) => void
}

export function useResize(initial: number, { min, max, side, onCommit }: ResizeOptions) {
  const [value, setValue] = useState(() => clamp(initial, min, max))
  const start = useRef({ x: 0, value: 0, dragging: false })
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      start.current = { x: event.clientX, value, dragging: true }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [value],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!start.current.dragging) return
      const delta = event.clientX - start.current.x
      const next = clamp(
        side === 'right' ? start.current.value + delta : start.current.value - delta,
        min,
        max,
      )
      setValue(next)
    },
    [min, max, side],
  )

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!start.current.dragging) return
      start.current.dragging = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      commitRef.current?.(value)
    },
    [value],
  )

  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  return {
    value,
    setValue: (next: number) => setValue(clamp(next, min, max)),
    handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
  }
}
