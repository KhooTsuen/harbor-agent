import { cn } from '@/lib/utils'
import type { ThreadStatus } from '@/types'
import { statusMeta } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   StatusDot —— 线程状态点

   执行中是个转圈，不是静态点（参考实现用「已处理 28s」那种进行中提示）。
   ══════════════════════════════════════════════════════════════ */

export interface StatusDotProps {
  status: ThreadStatus
  size?: number
  className?: string
}

export function StatusDot({ status, size = 8, className }: StatusDotProps) {
  const meta = statusMeta(status)
  const box = { width: size, height: size }

  if (meta.dot === 'spinning') {
    return (
      <span
        role="status"
        aria-label={meta.label}
        className={cn('inline-block shrink-0 rounded-full', className)}
        style={{
          ...box,
          border: '1.5px solid var(--border-strong)',
          borderTopColor: 'var(--text-secondary)',
        }}
      >
        <span className="sr-only">{meta.label}</span>
      </span>
    )
  }

  const color =
    meta.dot === 'green'
      ? 'var(--success)'
      : meta.dot === 'red'
        ? 'var(--danger)'
        : meta.dot === 'amber'
          ? 'var(--warning)'
          : 'var(--text-tertiary)'

  return (
    <span
      role="status"
      aria-label={meta.label}
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ ...box, background: color }}
    />
  )
}
