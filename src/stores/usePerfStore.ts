import { create } from 'zustand'
import type { PerfTimeline } from '@/types/safety'
import { metricsRecent } from '@/lib/safetyApi'

/* ══════════════════════════════════════════════════════════════
   性能时间线（AG-037）

   两个来源，各管一段：
     · 内核给六个时刻 + 分段耗时（上下文 / LLM / 工具 / 搜索 / 总量）
     · 渲染层自己测「首字上屏」—— 从**按下发送**到第一个字真的画在屏幕上。
       这一段（IPC + React 渲染）主进程测不到，硬测就是自欺（AG-003 那条注释里
       写得很清楚），所以在渲染层实测。

   运行中每轮结束都会刷新；拿不到就空着，面板显示「还没有数据」，不编。
   ══════════════════════════════════════════════════════════════ */

interface PerfState {
  /** 内核给的，新→旧 */
  recent: PerfTimeline[]
  /** 本轮「按下发送 → 首字出现在消息里」的毫秒数（渲染层实测） */
  firstPaintMs: number | null
  /** 本轮发出请求的时刻（渲染层记的「按下发送」） */
  sentAt: number
  loaded: boolean
  refresh: () => Promise<void>
  /** 记下「按下发送」的时刻，并把上一轮的首字上屏清掉 */
  beginRun: (at: number) => void
  /** 第一个字到了：等一帧再看，那才是真的画上去（不是塞进 store） */
  markFirstContent: () => void
}

export const usePerfStore = create<PerfState>((set, get) => ({
  recent: [],
  firstPaintMs: null,
  sentAt: 0,
  loaded: false,

  refresh: async () => {
    const recent = await metricsRecent(5)
    set({ recent, loaded: true })
  },

  beginRun: (at) => set({ sentAt: at, firstPaintMs: null }),

  markFirstContent: () => {
    const { sentAt, firstPaintMs } = get()
    if (!sentAt || firstPaintMs !== null) return
    /*
     * 用 requestAnimationFrame 而不是立刻算：事件到达 ≠ 已经画在屏幕上。
     * 差这一帧正是「渲染耗时」—— 立刻算会把这段算成 0，那这个数就没意义了。
     */
    if (typeof requestAnimationFrame !== 'function') {
      set({ firstPaintMs: Date.now() - sentAt })
      return
    }
    requestAnimationFrame(() => {
      const { firstPaintMs: still } = get()
      if (still !== null) return
      set({ firstPaintMs: Date.now() - sentAt })
    })
  },
}))
