import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useSmoothText } from '@/hooks/useSmoothText'

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
  /*
   * AG-023：思考链也要平滑。
   *
   * 它和正文是两个独立的通道（后端 `batcher` 按 type 分开攒），
   * 所以正文流畅不等于思考链流畅 —— 用户反馈里就是「正文一个字一个字出来，
   * 思考链还是一顿一顿的」。
   *
   * 而且这里是**整段塞进一个 div**（不解析），上游一次来 300 字就是
   * 一下子蹦 300 字，比 Markdown 那边更明显。
   */
  const smooth = useSmoothText(text, streaming)
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
        {/* 字数用平滑后的长度 —— 用原始 text.length 会跟着批次跳 */}
        <span className="font-mono">{smooth.length} 字</span>
      </button>

      {open ? (
        <div
          className="mt-1.5 whitespace-pre-wrap break-words border-l-2 pl-3 text-xs leading-relaxed text-fg-tertiary"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          {smooth}
        </div>
      ) : null}
    </div>
  )
}
