import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   IconButton —— 方形图标按钮，28 / 32 / 36
   ══════════════════════════════════════════════════════════════ */

export type IconButtonSize = 28 | 32 | 36

const SIZE_CLASS: Record<IconButtonSize, string> = {
  28: 'size-7',
  32: 'size-8',
  36: 'size-9',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: IconButtonSize
  active?: boolean
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 28, active = false, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'grid place-items-center rounded-sm',
        'transition-colors duration-fast ease-out',
        'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active && 'bg-bg-raised text-fg-primary',
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
