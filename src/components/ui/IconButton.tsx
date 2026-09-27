import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useMergeRefs } from '@floating-ui/react'
import { cn } from '@/lib/utils'
import { useTooltip } from './useTooltip'

/* ══════════════════════════════════════════════════════════════
   IconButton —— 方形图标按钮，28 / 32 / 36

   提示由**自己**渲染（见 useTooltip），不再用原生 `title`：
   原生 title 与外面包的样式化提示会同时弹出来（用户 2026-09-28 截图
   「新建单独对话」两个框叠在一起就是这个），而且原生提示不受控、没法统一。
   现在只有一个提示，而且挂在 body 上（侧栏那种滚动容器裁不到）。
   ══════════════════════════════════════════════════════════════ */

export type IconButtonSize = 28 | 32 | 36

const SIZE_CLASS: Record<IconButtonSize, string> = {
  28: 'size-7',
  32: 'size-8',
  36: 'size-9',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍名字，也是提示的默认文案 */
  label: string
  /** 更长的悬停提示（如「新建对话（Ctrl+N）」）；不传就用 label */
  hint?: ReactNode
  size?: IconButtonSize
  active?: boolean
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, hint, size = 28, active = false, className, children, ...rest },
  ref,
) {
  const tip = useTooltip(hint ?? label)
  const merged = useMergeRefs([ref, tip.setReference])

  return (
    <>
      <button
        ref={merged}
        type="button"
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
        {...tip.getReferenceProps({ 'aria-label': label })}
      >
        {children}
      </button>
      {tip.floating}
    </>
  )
})
