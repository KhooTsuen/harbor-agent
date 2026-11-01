import { create } from 'zustand'
import type { MessageAnchor } from '@/lib/scrollAnchor'

/* ══════════════════════════════════════════════════════════════
   每条对话的阅读记忆（本地 UI store，只存内存）

   滚动意图只有两种（见 `hooks/useAutoScroll.ts` 的状态机）：
     · follow —— 我在看最新内容
     · free   —— 我在看历史，别动我的视图

   这玩意儿**是用户显式选的**，不是推断出来的，所以切走再切回来必须
   还是那个状态、那个位置 —— 否则「切回对话」就等于把用户的意图清空了。

   一条记忆里有三样东西，各解决一个失效：
     · mode   —— 意图（follow / free），决定要不要恢复位置
     · anchor —— 视野顶那条**消息**（id + 相对视口偏移 + 下标）。像素会骗人：
                 切回来时窗口只渲染最近几条，同一个 scrollTop 可能对应另一段内容
     · top    —— 像素回退。只有还没有锚点的老状态 / 极短对话才用得上

   过程折叠区的**手动展开**状态也在这一层（`processOpen`，key =
   `threadId:messageId`）：它跟着消息走、不跟着组件实例走 —— 切到别的对话
   时整棵树卸载，组件本地 state 必然丢（这就是返回后过程又收起来的原因）。
   没在这里留痕的消息照旧听 `defaultOpen`（失败 / 中断默认展开，没有回归）。

   只存内存：应用重启后回到默认（最新对话贴底），和大多数聊天软件一致。
   不写盘，也不改会话文件的形状 —— 不需要迁移。
   ══════════════════════════════════════════════════════════════ */

export type ScrollMode = 'follow' | 'free'
export type { MessageAnchor }

export interface ScrollMemory {
  mode: ScrollMode
  /** 切走那一刻的 scrollTop（没有锚点时的回退口径） */
  top: number
  /** 切走那一刻视野顶那条消息（id + 相对视口偏移 + 下标） */
  anchor: MessageAnchor | null
}

interface ScrollMemoryState {
  byThread: Record<string, ScrollMemory>
  /** 每条对话里用户手动展开 / 折叠过的过程入口（key = `threadId:messageId`） */
  processOpen: Record<string, boolean>
  remember: (threadId: string, entry: ScrollMemory) => void
  setProcessOpen: (key: string, open: boolean) => void
}

export const useScrollStore = create<ScrollMemoryState>((set) => ({
  byThread: {},
  processOpen: {},
  remember: (threadId, entry) => set((s) => ({ byThread: { ...s.byThread, [threadId]: entry } })),
  setProcessOpen: (key, open) => set((s) => ({ processOpen: { ...s.processOpen, [key]: open } })),
}))
