import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   过程可见性

   这两块是「参考实现那种感觉」的关键：
     · 思考（reasoning）—— 默认折叠，点开才看
     · 工具调用 —— 一行一个，跑完显示耗时，失败标红

   默认只显示汇总，展开后才查看原始调用和输出，避免工具过程刷屏。
   ══════════════════════════════════════════════════════════════ */

/* ── 思考块 ───────────────────────────────────────────────── */

export function ThinkBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {streaming ? '正在思考…' : '思考过程'}
        <span className="font-mono">{text.length} 字</span>
      </button>

      {open ? (
        <div
          className="mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3 text-xs leading-relaxed text-fg-tertiary"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}
