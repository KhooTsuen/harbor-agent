import { AlertTriangle } from 'lucide-react'
import {
  SCHEDULE_GRANTS,
  scheduleGrantInfo,
  type ScheduleGrantId,
  type ScheduleListSnapshot,
} from '@/lib/schedulesApi'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   授权上限选择器（三档）

   ★ 这一段是整个功能里最要紧的界面：定时任务是**没人在场**的执行，
     用户在这里选的不是「偏好」，是「把它放到多大的笼子里」。

   所以每档的那句话**原样取内核的 `detail`**（`schedule-grant.cjs` 里逐条核过
   实际行为写出来的）。前端改一个字都会失真：
     写宽了 = 骗用户给权限；写严了 = 用户不敢用这个功能。

   取不到说明时**照实说取不到**，不编一句看着合理的顶上去。
   ══════════════════════════════════════════════════════════════ */

export function GrantPicker({
  value,
  snapshot,
  onChange,
}: {
  value: ScheduleGrantId
  snapshot: ScheduleListSnapshot | null
  onChange: (next: ScheduleGrantId) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {SCHEDULE_GRANTS.map((id) => {
        const info = scheduleGrantInfo(snapshot, id)
        const active = id === value
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={cn(
              'rounded-base border px-3 py-2 text-left transition-colors duration-fast',
              active ? 'border-line-focus bg-bg-raised' : 'border-line-hairline hover:bg-bg-hover',
            )}
          >
            <p className="text-dense text-fg-primary">
              {info ? info.label : id}
              {active ? <span className="ml-2 text-2xs text-fg-tertiary">已选</span> : null}
            </p>
            <p className="mt-0.5 text-2xs leading-relaxed text-fg-secondary">
              {info ? info.detail : '读不到这一档的说明（内核没返回），不敢替你解释它能干什么。'}
            </p>
          </button>
        )
      })}

      {value === 'full' ? (
        /*
         * 语义色从 `STATUS_CLASS` 来（AG-031：组件里自己写 `var(--warning)`
         * 会被 statusLanguage.test.ts 判红）。这里本来想调淡一点，但「同一语义
         * 任何页面同一个颜色」更重要 —— 为了一处好看破规矩，下一处就会跟着破。
         */
        <p
          className={`flex items-start gap-1.5 rounded-base border px-3 py-2 text-2xs leading-relaxed text-fg-secondary ${STATUS_CLASS.warning.border}`}
        >
          <AlertTriangle size={12} className={`mt-0.5 shrink-0 ${STATUS_CLASS.warning.text}`} />
          <span>即使是这一档，高风险命令和系统级改动仍然会被拒 —— 没人在场，没人能批准。</span>
        </p>
      ) : null}
    </div>
  )
}
