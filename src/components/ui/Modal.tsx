import { useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
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
}

const WIDTH_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
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
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  /* Esc 关闭 + 焦点管理 */
  useEffect(() => {
    if (!open) return

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
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-modal flex items-center justify-center p-6">
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
            className={cn(
              'glass-strong relative z-10 flex w-full flex-col',
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
              <IconButton label="关闭" onClick={onClose}>
                <X size={16} />
              </IconButton>
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
