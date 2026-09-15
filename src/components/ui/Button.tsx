import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Button

   注意 primary 的取色：主按钮是**白底黑字**，不是彩色。
   这是从三张不同截图里反复确认过的。
   ══════════════════════════════════════════════════════════════ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-fg-primary text-fg-inverse hover:bg-white active:bg-white/90 border border-transparent',
  secondary:
    'bg-bg-raised text-fg-primary hover:bg-bg-hover active:bg-bg-raised border border-line-subtle',
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
