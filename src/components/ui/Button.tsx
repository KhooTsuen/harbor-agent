import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Button

   注意 primary 的取色：走 `--cta-*` 主题变量 —— Primer 深色下是
   蓝底白字（accent-emphasis），浅色 / chatgpt / spec 主题各有自己的值。
   ══════════════════════════════════════════════════════════════ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-cta text-cta-fg hover:bg-cta-hover active:bg-cta-hover border border-transparent',
  secondary:
    'bg-bg-raised text-fg-primary hover:bg-bg-active active:bg-bg-active border border-line-subtle',
  ghost:
    'bg-transparent text-fg-secondary hover:bg-bg-hover hover:text-fg-primary border border-transparent',
  danger:
    'bg-transparent text-danger border border-danger/40 hover:bg-danger/10 active:bg-danger/15',
  glass: 'glass text-fg-primary hover:bg-bg-hover border border-line-subtle',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs rounded-sm gap-1.5',
  md: 'h-8 px-3 text-sm rounded gap-2',
  lg: 'h-10 px-4 text-base rounded gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled === true || loading}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium',
        'transition-colors duration-fast ease-out',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
})
