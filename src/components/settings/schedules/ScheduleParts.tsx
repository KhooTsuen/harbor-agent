import type { ScheduleGrantId, ScheduleGrantInfo } from '@/lib/schedulesApi'
import { relativeTime } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   定时任务面板的公用小零件

   只做「把内核给的字段翻译成人话」，**不重写任何内核文案**：
   授权档的名字永远取内核的 `label`，取不到就退回显示档位 id ——
   自己编一句「只读」之类的上去，就和内核实际行为分家了。
   ══════════════════════════════════════════════════════════════ */

/**
 * 「下次 09-25 09:30」里的那段时间。
 *
 * ★ `0` 的语义是「算不出来」（已停用 / 时间无效），显示成「—」。
 *   直接 `new Date(0)` 会渲染成 1970 年 —— 那是在骗用户。
 */
export function nextRunText(nextRunAt: number): string {
  const ts = Number(nextRunAt)
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 上次跑的时间（相对时间更好读：14 分 / 3 时） */
export function lastRunText(lastRunAt: number): string {
  const ts = Number(lastRunAt)
  if (!Number.isFinite(ts) || ts <= 0) return '还没跑过'
  return `${relativeTime(ts)}前`
}

/** 授权档徽章：文案取内核 label；内核没给就显示 id（不自己编） */
export function GrantBadge({
  grant,
  info,
}: {
  grant: ScheduleGrantId
  info: ScheduleGrantInfo | null
}) {
  return (
    <span
      className="shrink-0 rounded-sm bg-bg-surface px-1.5 py-0.5 text-2xs text-fg-secondary"
      title={info?.detail ?? '内核没有给出这一档的说明'}
    >
      授权：{info ? info.label : grant}
    </span>
  )
}
