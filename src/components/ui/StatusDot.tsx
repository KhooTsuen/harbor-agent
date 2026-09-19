import { cn } from '@/lib/utils'
import type { AgentPhase } from '@/types'
import { isActivePhase } from '@/lib/agentPhase'
import { STATUS_META, colorOf, labelOf, statusOfPhase } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   StatusDot —— 线程状态点（侧栏每行那个小圆点）

   AG-031：颜色和措辞都改走状态语言表。
   以前这里另有一套 `STATUSES`（空闲 / 执行中 / 完成 / 失败 / 等待 / 已停止 + 
   green/red/amber），是同一件事的**第四份说法** —— 侧栏说「执行中」，
   任务中心说「进行中」，用户得自己对应。
   另外它读的是旧的 `thread.status`；AG-001 之后真话在 `thread.phase`。

   执行中仍然是**转圈**，不是静态点 —— 那代表「正在动」，
   和「已完成」的实心点不能长一样。
   ══════════════════════════════════════════════════════════════ */

export interface StatusDotProps {
  /** 生命周期相位（AG-001 的 phase 才是真话；老对话可能没有） */
  phase?: AgentPhase
  size?: number
  className?: string
}

export function StatusDot({ phase, size = 8, className }: StatusDotProps) {
  const status = statusOfPhase(phase)
  const color = colorOf(status)
  const label = labelOf(status) || '空闲'
  const box = { width: size, height: size }

  if (isActivePhase(phase)) {
    return (
      <span
        role="status"
        aria-label={label}
        className={cn('inline-block shrink-0 animate-spin rounded-full', className)}
        style={{ ...box, border: `1.5px solid ${color}`, borderTopColor: 'transparent' }}
      >
        <span className="sr-only">{label}</span>
      </span>
    )
  }

  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ ...box, background: color }}
    />
  )
}

/** 供别处复用的「状态点该什么颜色」——同样是状态语言表那一份 */
export const statusDotColor = colorOf
export { STATUS_META }
