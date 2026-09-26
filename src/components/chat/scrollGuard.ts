import { createContext, useContext } from 'react'

/* ══════════════════════════════════════════════════════════════
   滚动意图的下行通道（Context）

   滚动意图是个显式状态机（见 `hooks/useAutoScroll.ts`）：

     FOLLOW 我在看最新内容，有新内容自动跟上
     FREE   我在看历史内容，别动我的视图

   但「用户点开了某块内容」这件事发生在列表深处（思考块、工具调用…），
   列表自己看不见 —— 所以这些组件在动作时通过本条通道喊一声
   `enterFree()`：迁移规则 4，展开/折叠一律进 FREE。

   这里**没有** hold / 锁 /「短暂禁止滚动」那套东西了：进 FREE 就是进 FREE，
   要回 FOLLOW 只有两条路（滚到离底 ≤ 4px、点「回到底部」按钮）。
   ══════════════════════════════════════════════════════════════ */

export interface ScrollGuard {
  /** 迁移规则 4：用户点开/折叠了可展开元素 → FREE */
  enterFree: () => void
}

export const ScrollGuardContext = createContext<ScrollGuard | null>(null)

/** 不在列表里（单测直接渲染块）时返回 null，调用方用可选链即可 */
export function useScrollGuard(): ScrollGuard | null {
  return useContext(ScrollGuardContext)
}
