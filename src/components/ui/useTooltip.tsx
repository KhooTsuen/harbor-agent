import { forwardRef, useCallback, useEffect, useId, useState, type ReactNode } from 'react'
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
 *   <button ref={tip.setReference} {...tip.getReferenceProps({ 'aria-label': label })} />
 *   {tip.floating}
 *
 * ★ 这个 hook 本身**必须便宜**：列表里一个会话行就有一两个 IconButton，
 * 侧栏一屏就几十个 —— 每个都挂一套 floating-ui 的话，切会话的挂载开销肉眼可见
 * （2026-09-28 实测：千条会话切换 251/263ms → 323/337ms，长任务 80ms → 117/145ms）。
 * 所以 floating-ui 那一套被挪到 `TooltipFloating` 里，**悬停 / 聚焦到它了才挂**。
 * 代价只有「第一次悬停晚一帧出提示」（upb 16ms，看不出来），换来满列表零开销。
 */
export function useTooltip(content: ReactNode, side: TooltipSide = 'bottom', className?: string) {
  const id = useId()
  /** 触发器元素（ref 回调拿；拿到之前浮层不挂） */
  const [reference, setNode] = useState<HTMLElement | null>(null)
  /** 被悬停 / 聚焦过没有 —— 一旦碰过就保持挂载，连续悬停不会反复装卸 */
  const [armed, setArmed] = useState(false)

  const setReference = useCallback((node: HTMLElement | null) => setNode(node), [])

  /* 带着调用点自己的同事件处理（有人传了 onMouseEnter 也不能丢） */
  const chain = (mine: () => void, theirs: unknown) => (event: unknown) => {
    mine()
    if (typeof theirs === 'function') (theirs as (e: unknown) => void)(event)
  }

  const getReferenceProps = (extra: Record<string, unknown> = {}) => ({
    ...extra,
    onMouseEnter: chain(() => setArmed(true), extra.onMouseEnter),
    onFocus: chain(() => setArmed(true), extra.onFocus),
    /** 挂上就带上：读屏器会把提示读出来 */
    'aria-describedby': armed ? id : undefined,
  })

  const floating =
    armed && reference ? (
      <TooltipFloating
        reference={reference}
        content={content}
        side={side}
        className={className}
        id={id}
        onClosed={() => setArmed(false)}
      />
    ) : null

  return {
    open: armed,
    setReference,
    getReferenceProps,
    describedBy: armed ? id : undefined,
    floating,
  }
}

/**
 * 浮层机器（floating-ui + portal）——**只在悬停/聚焦之后才挂**，见 `useTooltip`。
 *
 * 挂上时就已经是「开着」的（父级已经看到悬停/聚焦了），所以初始 `open = true`；
 * 之后鼠标移开 / 失焦 / Esc / 点外面 全交给 `useInteractions`。关掉就自我卸载
 * （`onClosed`），下次再碰再挂。
 */
export function TooltipFloating({
  reference,
  content,
  side,
  className,
  id,
  onClosed,
}: {
  reference: HTMLElement
  content: ReactNode
  side: TooltipSide
  className?: string
  id: string
  onClosed: () => void
}) {
  const [open, setOpen] = useState(true)

  const { refs, x, y, isPositioned, context } = useFloating({
    open,
    /* 先卸载再回调 —— 关掉就不要这套机器了 */
    onOpenChange: (next) => {
      setOpen(next)
      if (!next) onClosed()
    },
    elements: { reference },
    placement: side,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP),
      flip({ padding: VIEWPORT_PADDING }),
      shift({ padding: VIEWPORT_PADDING }),
    ],
  })

  const { getFloatingProps } = useInteractions([
    useHover(context),
    useFocus(context),
    useDismiss(context),
  ])

  /*
   * 窗口失焦 / 切到别的窗口 → 关掉。提示挂在 body 上，收不到 mouseleave，
   * 不关会一直挂在那儿（手写版就有这一条，别丢）。
   */
  useEffect(() => {
    const close = (): void => onClosed()
    window.addEventListener('blur', close)
    document.addEventListener('visibilitychange', close)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('visibilitychange', close)
    }
  }, [onClosed])

  if (!open || !content) return null

  return createPortal(
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
}
