import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Field / Select / Switch

   三个最小的表单原语放在一起，避免样式各写一遍。
   Field 的实现刻意用 div 包 input —— 图标装饰在左侧时不会被指针事件挡住。
   ══════════════════════════════════════════════════════════════ */

export interface FieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'prefix'
> {
  onChange: (value: string) => void
  /** 左侧图标 */
  leading?: ReactNode
  /** 右侧图标（清除按钮之类） */
  trailing?: ReactNode
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { onChange, leading, trailing, className, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded border border-line-subtle bg-bg-elevated px-2.5 py-1.5',
        'transition-colors duration-fast focus-within:border-line-focus',
        className,
      )}
    >
      {leading ? <span className="shrink-0 text-fg-tertiary">{leading}</span> : null}
      <input
        ref={ref}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        {...rest}
      />
      {trailing ? <span className="shrink-0 text-fg-tertiary">{trailing}</span> : null}
    </div>
  )
})

/* ── Select ────────────────────────────────────────────────── */

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  className?: string
  'aria-label'?: string
}

export function Select({ value, options, onChange, className, ...rest }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full appearance-none rounded border border-line-subtle bg-bg-elevated px-2.5 py-1.5',
        'text-sm text-fg-primary transition-colors duration-fast focus:border-line-focus focus:outline-none',
        className,
      )}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-bg-elevated text-fg-primary">
          {option.label}
        </option>
      ))}
    </select>
  )
}

/* ── Switch ────────────────────────────────────────────────── */

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
      )}
      style={{ background: checked ? 'var(--accent-blue)' : 'var(--bg-raised)' }}
    >
      <span
        className={cn(
          'absolute size-3.5 rounded-full bg-white transition-transform duration-fast',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
        style={{ boxShadow: '0 1px 2px rgb(0 0 0 / 0.35)' }}
      />
    </button>
  )
}
