import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pickGreeting, type Greeting, type GreetingUse } from '@/lib/greeting'

/* ══════════════════════════════════════════════════════════════
   开屏性格层的记账（本地偏好，不写会话、不写工作区）

   持久化的只有两样：开屏次数 + 最近用过的句子 ——
   「同一句至少间隔 5 次开屏或 24 小时」靠它们执行（设计文档 §23.8）。
   ══════════════════════════════════════════════════════════════ */

interface GreetingState {
  opens: number
  recent: GreetingUse[]
  /**
   * 每次开屏调一次：记账并返回本次要显示的那句。
   * 允许的候选全被间隔挡住时返回 null（宁可不出，不破规矩）。
   */
  draw: (hasHistory: boolean, normal: boolean, now?: Date) => Greeting | null
}

export const useGreetingStore = create<GreetingState>()(
  persist(
    (set, get) => ({
      opens: 0,
      recent: [],
      draw: (hasHistory, normal, now = new Date()) => {
        const { opens, recent } = get()
        const next = opens + 1
        const picked = pickGreeting({ now, hasHistory, normal, recent, opens: next })
        set({
          opens: next,
          recent: picked
            ? [...recent, { id: picked.id, at: now.getTime(), open: next }].slice(-40)
            : recent,
        })
        return picked
      },
    }),
    { name: 'harbor-greeting' },
  ),
)
