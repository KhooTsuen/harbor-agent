import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useSmoothText } from '@/hooks/useSmoothText'
import { useScrollGuard } from './scrollGuard'

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
   * 迁移规则 4：用户点开/折叠思考块（= 他自己动了布局）→ 直接 FREE。
   * 以前是 hold()：锁两帧、期间按高度差补偿那套推断逻辑 —— 已经删掉了。
   */
  const guard = useScrollGuard()
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
        onClick={() => {
          setOpen((v) => !v)
          guard?.enterFree()
        }}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {streaming ? '正在思考…' : '思考过程'}
        {/* 字数用平滑后的长度 —— 用原始 text.length 会跟着批次跳 */}
        <span className="font-mono">{smooth.length} 字</span>
      </button>

      {open ? (
        /*
         * Phase 7 二期：思考块展开区从「左竖线缩进块」换成**淡底卡** ——
         * 复用工具明细行那套观感（`rounded-sm border border-line-subtle bg-bg-raised/40`），
         * 不新增 Token。★ 只改 className：这个块流式时每帧重渲（`smooth` 在变），
         * 增删节点会让 React 重建子树 → 严格禁止。
         */
        <div className="mt-1.5 whitespace-pre-wrap break-words rounded-sm border border-line-subtle bg-bg-raised/40 px-3 py-2 text-xs leading-relaxed text-fg-secondary">
          {smooth}
        </div>
      ) : null}
    </div>
  )
}
