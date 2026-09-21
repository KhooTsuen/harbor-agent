import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { anchoredPlacement } from '@/lib/anchor'
import { IconButton } from './IconButton'

/* ══════════════════════════════════════════════════════════════
   Modal

   可访问性要点：
     · role="dialog" + aria-modal="true" + aria-labelledby
     · Esc 关闭
     · 打开时把焦点移到容器里，关闭后还给原来的元素
     · 遮罩点击关闭（可用 disableBackdropClose 关掉）
   ══════════════════════════════════════════════════════════════ */

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  /**
   * 固定高度（Tailwind 类，如 "h-[min(620px,85vh)]"）。
   * 不传则高度自适应内容（max-h 是 85vh）—— 但那样切换标签页时弹窗会跳，
   * 设置页要传一个固定值。
   */
  height?: string
  /** 点遮罩不关闭（危险确认框用） */
  disableBackdropClose?: boolean
  /** 交互形态：普通模态框，或贴近输入区的非阻塞确认条。 */
  variant?: 'modal' | 'anchored'
  /** anchored 模式是否显示右上角关闭按钮。 */
  showClose?: boolean
}

const WIDTH_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-[min(760px,calc(100vw-32px))]',
  /* 设置页用：大屏上尽量铺开，但四周留出缝（外面的 p-6 再兜一层） */
  '2xl': 'max-w-[min(1180px,92vw)]',
} as const

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
  height,
  disableBackdropClose = false,
  variant = 'modal',
  showClose = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  /*
   * anchored 时面板的位置（贴输入区上方）；null = 没找到输入区（退回居中）。
   * 水平也要：面板原来在窗口里居中，而输入区在对话列里居中，两个中心差 60px。
   */
  const [anchorRect, setAnchorRect] = useState<{
    bottom: number
    left: number
    width: number
  } | null>(null)

  /*
   * ★ anchored 的位置必须按输入区的**真实 rect** 算。
   *
   * 原来是用一个写死的 CSS 变量猜高度（`--composer-shell-h: 135px`）：
   * 宽度对（都是 760）但位置是死的 —— 输入框一长高（多行、附件、排队提示、
   * 权限条自己）面板就压到输入框上了。
   *
   * 这里每帧量一次（**只在确认面板开着的时候**跑，关掉就停），量到就跟着走；
   * 值没变就不 setState，所以不会白白重渲染。
   * 量不到输入区（比如在设置页里确认，那时没有 Composer）→ 退回居中。
   */
  useEffect(() => {
    if (!open || variant !== 'anchored') {
      setAnchorRect(null)
      return
    }
    let raf = 0
    let last = ''
    const tick = (): void => {
      const shell = document.querySelector('[data-composer-shell]')
      const next = shell
        ? anchoredPlacement(
            shell.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            /* 面板自己的高度也量一下：窗口很矮时靠它把面板压回视口内 */
            panelRef.current?.getBoundingClientRect().height ?? 0,
          )
        : null
      const key = next ? `${next.bottom}|${next.left}|${next.width}` : ''
      if (key !== last) {
        last = key
        setAnchorRect(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, variant])

  /* 真的贴上了（找到了输入区）才算 anchored；否则回退到居中模态 */
  const anchoredHere = variant === 'anchored' && anchorRect !== null

  /* Esc 关闭 + 焦点管理 */
  useEffect(() => {
    if (!open) return

    if (variant === 'anchored') return

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    /* 优先聚焦第一个可交互元素，没有就聚焦容器本身 */
    const first = panel?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    ;(first ?? panel)?.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      restoreFocusRef.current?.focus()
    }
  }, [open, onClose, variant])

  return (
    <AnimatePresence>
      {open ? (
        <div
          className={
            anchoredHere
              ? 'fixed inset-x-0 z-modal flex justify-start pointer-events-none'
              : 'fixed inset-0 z-modal flex items-center justify-center p-6'
          }
          style={anchoredHere && anchorRect ? { bottom: anchorRect.bottom } : undefined}
        >
          {anchoredHere ? null : (
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0"
              style={{ background: 'var(--bg-overlay)' }}
              onClick={disableBackdropClose ? undefined : onClose}
            />
          )}
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            style={
              anchoredHere && anchorRect
                ? { marginLeft: anchorRect.left, width: anchorRect.width }
                : undefined
            }
            className={cn(
              'glass-strong relative z-10 flex flex-col pointer-events-auto',
              anchoredHere && anchorRect ? '' : 'w-full',
              variant === 'anchored'
                ? 'max-h-[min(32vh,280px)] max-w-[var(--content-max-width)]'
                : '',
              'rounded-base shadow-modal outline-none',
              height ?? 'max-h-[85vh]',
              WIDTH_CLASS[width],
            )}
          >
            <header className="flex items-start gap-3 border-b border-line-subtle px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 id="modal-title" className="text-md font-semibold text-fg-primary">
                  {title}
                </h2>
                {description ? (
                  <p className="mt-0.5 text-xs text-fg-secondary">{description}</p>
                ) : null}
              </div>
              {showClose ? (
                <IconButton label="关闭" onClick={onClose}>
                  <X size={16} />
                </IconButton>
              ) : null}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

            {footer ? (
              <footer className="flex items-center justify-end gap-2 border-t border-line-subtle px-5 py-3">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  )
}
