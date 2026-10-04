import { Tooltip } from '@/components/ui/Tooltip'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf, labelOf, statusOfPhase } from '@/lib/statusLanguage'
import { isActivePhase } from '@/lib/agentPhase'
import type { Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   对话行的「还没看过」提醒点（真机反馈 4）

   单独一个组件而不是塞在 ThreadRow 里：那边已经贴着 300 行了
   （硬约束 #2），而这一块自己就完整 —— 「有没有点」的判断 + 长什么样。

   口径：
     · 状态在 useUIStore.unread（**内存态**：点开即清、重启即清，不是历史记录）；
     · 颜色只从状态语言表取（colorOf），组件里不写死色值；
     · 这条对话又跑起来了 → 转成「进行中」的蓝（至少让人知道它还在动）。
   ══════════════════════════════════════════════════════════════ */

export function UnreadDot({ thread }: { thread: Thread }) {
  const phase = useUIStore((s) => s.unread[thread.id])
  if (!phase) return null
  /* 真话在 phase 上（AG-001），别用旧的 status */
  const status = statusOfPhase(isActivePhase(thread.phase) ? thread.phase : phase)
  const label = `${labelOf(status)} · 还没看过`
  return (
    <Tooltip content={label}>
      <span
        role="status"
        aria-label={label}
        className="inline-block size-1.5 shrink-0 animate-pulse-slow rounded-full"
        style={{ background: colorOf(status) }}
      />
    </Tooltip>
  )
}
