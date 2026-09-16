import { useEffect, useId, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Tooltip

   自己写的轻量版：hover / focus 时显示，纯 CSS 定位，不引第三方库。
   为了可访问性，用 aria-describedby 关联。
   ══════════════════════════════════════════════════════════════ */

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  children: ReactNode
  className?: string
}

const SIDE_CLASS: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
}

export function Tooltip({ content, side = 'bottom', children, className }: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)

  /*
   * 光靠 mouseleave 关不干净：窗口失焦、或者鼠标移到网页盖不到的地方（原生按钮、
   * 拖拽区）时，网页侧就收不到 mouseleave 了，提示会一直挂着。
   * 所以再加两个出口。
   */
  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('blur', close)
    document.addEventListener('visibilitychange', close)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('visibilitychange', close)
    }
  }, [])

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && content ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-dropdown whitespace-nowrap',
            'rounded-sm border border-line-subtle bg-bg-elevated px-2 py-1',
            'text-2xs text-fg-primary shadow-mid animate-fade-in',
            SIDE_CLASS[side],
            className,
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
