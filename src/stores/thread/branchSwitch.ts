import type { ForkPoint } from '@/lib/branchPath'
import { useThreadStore } from '../useThreadStore'

/* ══════════════════════════════════════════════════════════════
   从分叉点切到另一条分支

   两条路走两个既有动作，都不新造机制：
     · 提问版（question）→ activateUserVersion：写盘（版本 + 这个位置的回答选择）
       + 重读；后面几轮按新版本自己回来（内核 parentVersion 筛，见 56 组自检）
     · 回答版（answer）→ activateAnswer：换一条显示，不重跑（选择写回提问记录）
   ══════════════════════════════════════════════════════════════ */

export function switchBranch(fork: ForkPoint, index: number): void {
  const store = useThreadStore.getState()
  if (fork.kind === 'question') store.activateUserVersion(fork.threadId, fork.id, index)
  else store.activateAnswer(fork.threadId, fork.id, index)
}
