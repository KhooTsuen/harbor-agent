import type { AgentPhase } from '@/types'
import { isTerminalPhase } from '@/lib/agentPhase'
import { useAppStore } from '../useAppStore'

/* ══════════════════════════════════════════════════════════════
   A1（Phase 5）：一轮结束时把 phase 收口到终态。

   从 `turns.ts` 拆出来（那边贴着 300 行红线）。为什么必须有这一步：

   UI 的「运行中」是 `sendingThreads || isActivePhase(phase)`
   （见 `hooks/useAgentActive.ts`），而 `phase` **只由主进程事件推进**。
   终止事件一旦没到达（例如长命令静默期间被兜底时钟放弃接收），`phase`
   就永远停在 `executing`，界面永久假死 —— 代码里没有别的地方会复位它。

   这不是「私自重置 phase」：只**补**主进程没给的那次终态转移；主进程已经
   推过终态（completed/failed/cancelled）就不覆盖 —— 它是权威（AG-001）。
   ══════════════════════════════════════════════════════════════ */

/** 这一轮「为什么结束」→ 该落的终态 phase。null = 这个 reason 不管 phase。 */
function terminalPhaseFor(reason: string): AgentPhase | null {
  if (reason === 'done' || reason === 'completed') return 'completed'
  if (reason === 'aborted' || reason === 'cancelled') return 'cancelled'
  /* timeout = 兜底时钟放弃接收；failed = 发送失败。两者主进程都不会推终态，只能这里补。 */
  if (reason === 'error' || reason === 'failed' || reason === 'timeout') return 'failed'
  return null
}

export function applyTerminalPhase(threadId: string, reason: string): void {
  const phase = terminalPhaseFor(reason)
  if (!phase) return
  const app = useAppStore.getState()
  if (isTerminalPhase(app.threads.find((t) => t.id === threadId)?.phase)) return
  app.setThreadPhase(threadId, phase)
}
