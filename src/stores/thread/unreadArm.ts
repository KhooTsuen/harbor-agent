import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import type { AgentPhase } from '@/types'

/* ══════════════════════════════════════════════════════════════
   给对话行点「还没看过」的小点（真机反馈 4）

   从 streamEvents 里抽出来的：那边贴着 300 行，而这条规矩自己就能说清 ——
   「跑完 / 失败 / 等你确认，且用户不在看这条」→ 点一个点。

   为什么单独成文件而不是塞回 store：它跨两个 store（会话状态 + UI 提示），
   塞进任何一个都会让那个 store 反过来 import 另一个（循环依赖）。
   ══════════════════════════════════════════════════════════════ */

/** 值得点一个点的相位：一轮结束了，或者卡住等人 */
const DOT_PHASES: ReadonlySet<string> = new Set(['completed', 'failed', 'waiting_user'])

export function armUnread(threadId: string, phase: AgentPhase): void {
  if (!DOT_PHASES.has(phase)) return
  /* 用户正在看这条 → 不点（人就在这儿看着）；点开后由 setActiveThread 清掉 */
  if (useAppStore.getState().activeThreadId === threadId) return
  useUIStore.getState().markUnread(threadId, phase)
}
