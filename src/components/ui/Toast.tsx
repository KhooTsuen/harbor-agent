import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import type { Toast, ToastKind } from '@/types'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf, statusOfToast } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   Toast —— 右下角堆叠，自动消失，可手动关
   ══════════════════════════════════════════════════════════════ */

/* AG-031：颜色取自状态语言表 —— 轻提示也是状态的一种表达 */
const KIND_META: Record<ToastKind, { icon: typeof Info; color: string }> = {
  success: { icon: CheckCircle2, color: colorOf(statusOfToast('success')) },
  error: { icon: XCircle, color: colorOf(statusOfToast('error')) },
  warning: { icon: AlertTriangle, color: colorOf(statusOfToast('warning')) },
  info: { icon: Info, color: colorOf(statusOfToast('info')) },
}

const AUTO_DISMISS_MS = 4200
/** 带「行动按钮」的提示多留一会儿 —— 4 秒来不及看清再点（AG-029 任务完成通知）*/
const AUTO_DISMISS_WITH_ACTION_MS = 9000

function ToastCard({ toast }: { toast: Toast }) {
  const hideToast = useUIStore((s) => s.hideToast)
  const { icon: Icon, color } = KIND_META[toast.kind]
  const timer = useRef<number | null>(null)
  const started = useRef(0)
  const remaining = useRef(toast.action ? AUTO_DISMISS_WITH_ACTION_MS : AUTO_DISMISS_MS)
  const hovered = useRef(false)
  const focused = useRef(false)

  const pause = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
      remaining.current -= Date.now() - started.current
    }
  }, [])
  const resume = useCallback(() => {
    if (toast.kind === 'error' || toast.kind === 'warning' || toast.action) return
    if (hovered.current || focused.current || document.hidden || timer.current !== null) return
    started.current = Date.now()
    timer.current = window.setTimeout(() => hideToast(toast.id), Math.max(0, remaining.current))
  }, [toast.kind, toast.action, toast.id, hideToast])

  useEffect(() => {
    const visibility = () => (document.hidden ? pause() : resume())
    document.addEventListener('visibilitychange', visibility)
    resume()
    return () => {
      pause()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [pause, resume])

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
      onMouseEnter={() => {
        hovered.current = true
        pause()
      }}
      onMouseLeave={() => {
        hovered.current = false
        resume()
      }}
      onFocusCapture={() => {
        focused.current = true
        pause()
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        focused.current = false
        resume()
      }}
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
            className="mt-1.5 rounded-sm border border-line-subtle bg-bg-raised px-2 py-0.5 text-2xs text-fg-primary transition-colors duration-fast hover:bg-bg-active"
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
  const history = useUIStore((s) => s.toastHistory)
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div
      className="pointer-events-none fixed bottom-10 right-4 z-toast flex flex-col-reverse gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {history.length > 0 ? (
        <div className="pointer-events-auto self-end">
          <button
            type="button"
            onClick={() => setShowHistory((open) => !open)}
            className="rounded-sm border border-line-hairline bg-bg-raised px-2 py-1 text-xs text-fg-secondary"
          >
            重要通知记录（{history.length}）
          </button>
          {showHistory ? (
            <div className="mt-1 max-h-64 w-80 overflow-y-auto rounded-sm border border-line-hairline bg-bg-raised p-2">
              <p className="mb-1 text-2xs text-fg-tertiary">本次打开期间的重要通知</p>
              {history
                .slice()
                .reverse()
                .map((item) => (
                  <div
                    key={item.id}
                    className="border-t border-line-hairline py-1 text-xs text-fg-secondary"
                  >
                    <b>{item.title}</b>
                    {item.description ? ` · ${item.description}` : ''}
                    {item.action ? (
                      <button
                        type="button"
                        className="ml-1 underline"
                        onClick={item.action.onClick}
                      >
                        {item.action.label}
                      </button>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}
