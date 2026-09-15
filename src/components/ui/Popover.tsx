import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   Popover —— 自己写的轻量浮层

   为什么不用第三方：只需要「点外面关掉 / Esc 关掉 / 贴着触发器」这三件事。
   浮层用 .glass，这样玻璃拟态开关一开，所有菜单会一起生效。

   **渲染到 body**（portal）：以前直接挂在触发器旁边，只要哪个祖先有
   `overflow: auto`（设置弹窗的内容区就是），菜单一伸出去就被裁掉半截。
   现在用 fixed 定位挂在 body 上，祖先怎么滚都不影响。
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
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  /* 位置算完之前先藏着 —— 不然会看到浮层从屏幕角落跳过来 */
  const place = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return

    const a = anchor.getBoundingClientRect()
    const p = panel.getBoundingClientRect()

    let left = align === 'end' ? a.right - p.width : a.left
    const top = side === 'top' ? a.top - p.height - GAP : a.bottom + GAP

    /* 夹进视口：宁可盖住触发器，也不要有半截跑到屏幕外 */
    left = Math.max(
      VIEWPORT_PADDING,
      Math.min(left, window.innerWidth - p.width - VIEWPORT_PADDING),
    )

    setPosition({
      left,
      top: Math.max(
        VIEWPORT_PADDING,
        Math.min(top, window.innerHeight - p.height - VIEWPORT_PADDING),
      ),
    })
  }, [align, side])

  /* 打开时先量一次（layout 阶段，浏览器还没画出来） */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    place()
  }, [open, place])

  /* 窗口尺寸或滚动位置变了要重摆 */
  useEffect(() => {
    if (!open) return
    const onMove = (): void => place()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, place])

  /* 点外面关掉 / Esc 关掉。浮层在 body 上，所以两边都要判断 */
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
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
  }, [open, onOpenChange])

  return (
    <div ref={anchorRef} className="relative inline-flex">
      {trigger({ open, toggle: () => onOpenChange(!open) })}
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0, 0, 0.2, 1] }}
              role="menu"
              style={{
                position: 'fixed',
                left: position?.left ?? -9999,
                top: position?.top ?? -9999,
                visibility: position ? 'visible' : 'hidden',
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
