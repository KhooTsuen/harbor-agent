import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import type { Toast, ToastKind } from '@/types'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   Toast —— 右下角堆叠，自动消失，可手动关
   ══════════════════════════════════════════════════════════════ */

const KIND_META: Record<ToastKind, { icon: typeof Info; color: string }> = {
  success: { icon: CheckCircle2, color: 'var(--success)' },
  error: { icon: XCircle, color: 'var(--danger)' },
  warning: { icon: AlertTriangle, color: 'var(--warning)' },
  info: { icon: Info, color: 'var(--info)' },
}

const AUTO_DISMISS_MS = 4200
/** 带「行动按钮」的提示多留一会儿 —— 4 秒来不及看清再点（AG-029 任务完成通知）*/
const AUTO_DISMISS_WITH_ACTION_MS = 9000

function ToastCard({ toast }: { toast: Toast }) {
  const hideToast = useUIStore((s) => s.hideToast)
  const { icon: Icon, color } = KIND_META[toast.kind]

  useEffect(() => {
    const ttl = toast.action ? AUTO_DISMISS_WITH_ACTION_MS : AUTO_DISMISS_MS
    const timer = window.setTimeout(() => hideToast(toast.id), ttl)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.action, hideToast])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className="glass pointer-events-auto flex w-80 items-start gap-2.5 rounded-md p-3 shadow-high"
      role="status"
      aria-live="polite"
    >
      <Icon size={16} style={{ color }} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg-primary">{toast.title}</p>
        {toast.description ? (
          /* whitespace-pre-line：任务通知要按行摆（「名字」/ 改了 N 个文件 / 结果）*/
          <p className="mt-0.5 whitespace-pre-line break-words text-xs text-fg-secondary">
            {toast.description}
          </p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              hideToast(toast.id)
              toast.action?.onClick()
            }}
            className="mt-1.5 rounded-sm border border-line-subtle bg-bg-raised px-2 py-0.5 text-2xs text-fg-primary transition-colors duration-fast hover:bg-bg-hover"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => hideToast(toast.id)}
        className="-m-1 shrink-0 rounded p-1 text-fg-tertiary transition-colors hover:text-fg-primary"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}

export function ToastViewport() {
  const toasts = useUIStore((s) => s.toasts)

  return (
    <div
      className="pointer-events-none fixed bottom-10 right-4 z-toast flex flex-col-reverse gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}
