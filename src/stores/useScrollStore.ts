import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   每条对话的滚动记忆（本地 UI store）

   滚动意图只有两种（见 `hooks/useAutoScroll.ts` 的状态机）：
     · follow —— 我在看最新内容
     · free   —— 我在看历史，别动我的视图

   这玩意儿**是用户显式选的**，不是推断出来的，所以切走再切回来必须
   还是那个状态、那个位置 —— 否则「切回对话」就等于把用户的意图清空了。

   只存内存：应用重启后回到默认（最新对话贴底），和大多数聊天软件一致。
   ══════════════════════════════════════════════════════════════ */

export type ScrollMode = 'follow' | 'free'

export interface ScrollMemory {
  mode: ScrollMode
  /** 切走那一刻的 scrollTop（follow 用不上，free 恢复用） */
  top: number
}

interface ScrollMemoryState {
  byThread: Record<string, ScrollMemory>
  remember: (threadId: string, entry: ScrollMemory) => void
}

export const useScrollStore = create<ScrollMemoryState>((set) => ({
  byThread: {},
  remember: (threadId, entry) => set((s) => ({ byThread: { ...s.byThread, [threadId]: entry } })),
}))
