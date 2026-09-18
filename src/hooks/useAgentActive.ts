import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { isActivePhase } from '@/lib/agentPhase'

/* ══════════════════════════════════════════════════════════════
   AG-003：这条对话现在「在跑」吗？

   两个来源，缺一不可：

   · **`sendingThreads`** —— 渲染层本地已经提交（按下发送那一瞬就置上）。
     没有它，从「按下发送」到「主进程回第一个事件」这段时间界面是死的：
     用户面对一个毫无反应的按钮，会以为没点上，然后再点一次。

   · **`phase`** —— 主进程状态机的真实相位（AG-001）。它才是权威；
     本地那个只说明「送出去了」，不代表后台真的在跑。

   用 OR：本地已提交（还没收到回音）**或** 后台确实在跑。
   —— 这和 AG-001 反的是同一件事的两面：AG-001 反对「渲染层猜后台状态」，
   这里补的是「渲染层连自己刚提交过都不知道」。
   ══════════════════════════════════════════════════════════════ */

export function useAgentActive(threadId: string | undefined): boolean {
  const localPending = useThreadStore((s) =>
    threadId ? s.sendingThreads.includes(threadId) : false,
  )
  const phase = useAppStore((s) => s.threads.find((t) => t.id === threadId)?.phase)
  return localPending || isActivePhase(phase)
}
