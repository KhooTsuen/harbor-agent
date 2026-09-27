import { forwardRef, useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
} from '@floating-ui/react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   提示（tooltip）的地基

   `Tooltip` 组件和 `IconButton` 都用它 —— 提示只有**一套**实现，样式/定位/关闭
   规则都在这儿，别在组件里再写一遍。

   ★ 为什么要挂到 body 上（2026-09-28 修的真机 bug）：
   提示原来是「绝对定位在触发器旁边的 span」。侧栏这种**滚动容器**里
   （`overflow-y-auto`）就被裁掉半截 —— 用户截图里「新建对话并指定…」显示不全
   就是这个。现在走 floating-ui + portal：
     · portal 到 body：祖先裁不到它
     · flip：下面放不下就翻到上面
     · shift：横向也夹回可视范围（贴边的按钮不再把提示挤出屏幕）
     · autoUpdate：祖先滚动 / 缩放 / 尺寸变化自动重算
   顺带：算坐标前先 `visibility: hidden`，不然会看到提示从屏幕角落跳过来
   （Popover 那边踩过同一个坑）。

   `side` 只给个**偏好**：真放不下时 flip 会改，这是有意的。
   ══════════════════════════════════════════════════════════════ */

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

/** 离触发器、离视口边缘各留多少 */
const GAP = 6
const VIEWPORT_PADDING = 8

/**
 * 提示框本体（视觉规格是唯一一份）。
 *
 * ★ 必须是 forwardRef：floating-ui 的 `refs.setFloating` 是以 ref 属性传进来的，
 * React 18 里普通函数组件拿不到 ref（只有 props），浮层就永远量不到尺寸 →
 * `isPositioned` 永远 false → 提示一直 visibility:hidden。测试看不出来（DOM 在），真机上就是不出提示。
 */
export const TooltipBox = forwardRef<
  HTMLSpanElement,
  {
    children: ReactNode
    style: React.CSSProperties
    floatingProps: Record<string, unknown>
    id: string
    className?: string
  }
>(function TooltipBox({ children, style, floatingProps, id, className }, ref) {
  return (
    <span
      id={id}
      ref={ref}
      role="tooltip"
      style={style}
      {...floatingProps}
      className={cn(
        'pointer-events-none z-dropdown whitespace-nowrap',
        'rounded-sm border border-line-subtle bg-bg-elevated px-2 py-1',
        'text-2xs text-fg-primary shadow-mid animate-fade-in',
        className,
      )}
    >
      {children}
    </span>
  )
})

/**
 * 把提示挂在**你自己的元素**上（不额外造 DOM）。
 *
 * 用法：
 *   const tip = useTooltip('说明')
 *   <button ref={tip.setReference} {...tip.getReferenceProps({ 'aria-describedby': tip.describedBy })} />
 *   {tip.floating}
 */
export function useTooltip(content: ReactNode, side: TooltipSide = 'bottom', className?: string) {
  const [open, setOpen] = useState(false)
  const id = useId()

  const { refs, x, y, isPositioned, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: side,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP),
      flip({ padding: VIEWPORT_PADDING }),
      shift({ padding: VIEWPORT_PADDING }),
    ],
  })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context),
    useFocus(context),
    useDismiss(context),
  ])

  /*
   * 窗口失焦 / 切到别的窗口 → 关掉。提示挂在 body 上，收不到 mouseleave，
   * 不关会一直挂在那儿（手写版就有这一条，别丢）。
   */
  useEffect(() => {
    const close = (): void => setOpen(false)
    window.addEventListener('blur', close)
    document.addEventListener('visibilitychange', close)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('visibilitychange', close)
    }
  }, [])

  const floating =
    open && content
      ? createPortal(
          <TooltipBox
            id={id}
            ref={refs.setFloating}
            floatingProps={getFloatingProps()}
            className={className}
            style={{
              position: 'fixed',
              left: x,
              top: y,
              visibility: isPositioned ? 'visible' : 'hidden',
            }}
          >
            {content}
          </TooltipBox>,
          document.body,
        )
      : null

  return {
    open,
    setReference: refs.setReference,
    getReferenceProps,
    /** 开着的时候给触发器带上：读屏器会把提示读出来 */
    describedBy: open ? id : undefined,
    floating,
  }
}
