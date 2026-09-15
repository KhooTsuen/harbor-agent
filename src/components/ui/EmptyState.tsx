import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   EmptyState

   刻意**不用插画**——空状态是「图形 + 文案 + 建议卡」，
   而且那三张卡上的图标带流动渐变。插画是 AI 生成 UI 最容易滥用的东西。
   ══════════════════════════════════════════════════════════════ */

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}
    >
      {/*
        图标放进一个方框里 —— 右栏那三个标签（审查 / 文件 / 浏览器）的空状态
        都用这一套，风格才统一。以前是一个孤零零的小图标，看着像没做完。
      */}
      {icon ? (
        <div className="mb-4 flex size-20 items-center justify-center rounded-lg border border-line-hairline bg-bg-surface/40 text-fg-tertiary">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-fg-primary">{title}</p>
      {description ? (
        <p className="mt-1 max-w-lg text-balance text-xs leading-relaxed text-fg-secondary">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
