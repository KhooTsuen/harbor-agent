import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  autoUpdate,
  flip,
  hide,
  offset,
  shift,
  useFloating,
  type Placement,
} from '@floating-ui/react'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Popover —— 轻量浮层（定位交给 floating-ui）

   浮层用 .glass，这样玻璃拟态开关一开，所有菜单会一起生效。
   **渲染到 body**（portal）：祖先有 `overflow: auto` 时不会被裁掉半截。

   ★ 定位为什么换了 floating-ui（2026-09-25 修的真机 bug）：
   手写版只会在 scroll / resize 手算坐标、并把结果**夹进视口** —— 真机复现：
   锚点在滚动容器顶部时面板被夹死在视口顶（压在面包屑上）；滚动 +120px 时
   面板位移=0（看起来“停在原地不跟随”）；锚点滚出视野后面板还挂着挡消息。
   现在：
     · autoUpdate：祖先滚动 / 窗口缩放 / 元素尺寸变化 / 布局位移都会重算
     · flip：上方放不下就翻到下面（不再夹死在一侧）
     · shift（含 crossAxis）：主轴和横轴都夹回可视范围
     · hide：锚点被裁掉（滚出滚动容器的可见区）→ 浮层直接关掉
   ══════════════════════════════════════════════════════════════ */

export type PopoverSide = 'top' | 'bottom'

export interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 触发器 */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode
  side?: PopoverSide
  align?: 'start' | 'end'
  className?: string
}

/** 离视口边缘至少留这么多，免得贴着边 */
const VIEWPORT_PADDING = 8
/** 浮层和触发器之间的间隙 */
const GAP = 6

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  side = 'top',
  align = 'start',
  className,
}: PopoverProps) {
  const placement: Placement = `${side}-${align === 'end' ? 'end' : 'start'}` as Placement

  const { refs, x, y, isPositioned, middlewareData } = useFloating({
    open,
    placement,
    strategy: 'fixed',
    /* 滚动 / 缩放 / 尺寸变化都自动重算（这就是 autoUpdate 中间件的用法） */
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP),
      flip({ padding: VIEWPORT_PADDING }),
      /* crossAxis：横轴也夹 —— “水平方向也要处理”就靠它 */
      shift({ padding: VIEWPORT_PADDING, crossAxis: true }),
      hide(),
    ],
  })

  /*
   * 锚点被裁掉（滚出滚动容器的可见区）→ 直接关掉。
   * 不关的话它会一直挂在视口边上挡别的消息（真机复现过）。
   */
  const referenceHidden = middlewareData.hide?.referenceHidden
  useEffect(() => {
    if (open && referenceHidden) onOpenChange(false)
  }, [open, referenceHidden, onOpenChange])

  /* 点外面关掉 / Esc 关掉。浮层在 body 上，所以两边都要判断 */
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node
      const anchor = refs.reference.current
      const panel = refs.floating.current
      if (anchor instanceof Element && anchor.contains(target)) return
      if (panel instanceof Element && panel.contains(target)) return
      onOpenChange(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange, refs])

  return (
    <div ref={refs.setReference} className="relative inline-flex">
      {trigger({ open, toggle: () => onOpenChange(!open) })}
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={refs.setFloating}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0, 0, 0.2, 1] }}
              role="menu"
              style={{
                /*
                 * 用 left/top 而不是 floatingStyles 里的 transform：
                 * motion 的 scale 动画也写 transform，两者会打架。
                 */
                position: 'fixed',
                left: x,
                top: y,
                /* 位置算完之前先藏着 —— 不然会看到浮层从屏幕角落跳过来 */
                visibility: isPositioned ? 'visible' : 'hidden',
              }}
              className={cn(
                'glass z-popover min-w-56 overflow-hidden rounded-md p-1 shadow-high',
                className,
              )}
            >
              {children}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

/* ── 菜单项 ────────────────────────────────────────────────── */

export interface MenuItemProps {
  selected?: boolean
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
  /** 右侧附注（说明文字或快捷键） */
  hint?: ReactNode
  icon?: ReactNode
}

export function MenuItem({
  selected = false,
  disabled = false,
  onSelect,
  children,
  hint,
  icon,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
        'transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-40',
        selected
          ? 'bg-bg-raised text-fg-primary'
          : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
      )}
    >
      {icon ? <span className="shrink-0 text-fg-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-2xs text-fg-tertiary">{hint}</span> : null}
      {selected ? (
        <span
          className="shrink-0 text-xs"
          style={{ color: 'var(--accent-blue)' }}
          aria-hidden="true"
        >
          ✓
        </span>
      ) : null}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-2xs uppercase tracking-wide text-fg-tertiary">
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line-subtle" role="separator" />
}
