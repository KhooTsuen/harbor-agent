import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { IconButton } from './IconButton'
import { useTooltip, type TooltipSide } from './useTooltip'

/* ══════════════════════════════════════════════════════════════
   Tooltip —— 悬停 / 聚焦时的说明（定位与关闭规则在 useTooltip）

   ★ 子元素是 `IconButton` 时，**把提示交给它自己渲染**（这里不再套壳）。

   为什么（用户 2026-09-28 报的「两个提示叠一起」）：IconButton 自带
   `title={label}`（原生提示），外面再包一个样式化提示 → 悬停时**两个一起弹**。
   现在 IconButton 不再设原生 title，由它自己渲染这一个（挂到 body、不被裁切），
   这里只把文案递过去（`hint`）。
   调用点**一行都不用改**：`<Tooltip content="…"><IconButton …/></Tooltip>`
   照旧写着，行为统一到一套提示上。

   其它元素走下面的通用分支（外面套一个 inline-flex 的 span 当锚点）。
   ══════════════════════════════════════════════════════════════ */

export type { TooltipSide }

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  children: ReactNode
  className?: string
}

export function Tooltip({ content, side = 'bottom', children, className }: TooltipProps) {
  /* 交给子元素自己渲染（判断用组件本身，不做字符串匹配） */
  if (isValidElement(children) && children.type === IconButton) {
    return cloneElement(children as ReactElement<{ hint?: ReactNode }>, { hint: content })
  }

  return (
    <TooltipAnchor content={content} side={side} className={className}>
      {children}
    </TooltipAnchor>
  )
}

function TooltipAnchor({
  content,
  side,
  className,
  children,
}: {
  content: ReactNode
  side: TooltipSide
  className?: string
  children: ReactNode
}) {
  const tip = useTooltip(content, side, className)
  return (
    <span ref={tip.setReference} {...tip.getReferenceProps()} className="relative inline-flex">
      {children}
      {tip.floating}
    </span>
  )
}
