/* ══════════════════════════════════════════════════════════════
   用量闸的「现在到底限不限」

   摆在开关正下方 —— 用户勾完开关最想知道的就是这句。措辞在
   `@/lib/usageGate`（纯函数，单独测），这里只负责画。
   ══════════════════════════════════════════════════════════════ */

import type { LimitsGateState } from '@/types/backend'
import { STATUS_META } from '@/lib/statusLanguage'
import { gateSummary } from '@/lib/usageGate'

export function GateStatus({ gate }: { gate: LimitsGateState | undefined }) {
  const lines = gateSummary(gate)
  /* 老版本内核不带 gate / 浏览器预览没配置 → 什么都不说（不瞎猜） */
  if (lines.length === 0) return null

  return (
    <ul className="mt-1 flex flex-col gap-1 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2">
      {lines.map((line) => (
        <li key={line.text} className="flex items-start gap-1.5 text-dense text-fg-secondary">
          <span
            className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
            /* 颜色一律问状态语言表（AG-031：组件里不许自己写 var(--success) 这类） */
            style={{ background: STATUS_META[line.status].color }}
          />
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  )
}
