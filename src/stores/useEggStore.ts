import { create } from 'zustand'

/* ══════════════════════════════════════════════════════════════
   彩蛋的运行时信号（不持久化）

   · sweepSeq —— 灯塔「完整扫一次」的信号。每次 +1，开屏里的灯塔
     按序号播一次动画（1-2 秒），播完回到真实状态的光。
   · greenAt  —— 「航道畅通」触发时刻。绿色细线层按它显示约 2.4 秒。
     **只在真实测试通过时**被 celebrateGreen 触发（见 HarborEggs.tsx，
     判据来自内核 task-outcome 的 exitOk，不是模型说了算）。

   「次数」这类要留下来的东西进 settings（greenRuns / nightUnlocked），
   这里只放转瞬即逝的信号。
   ══════════════════════════════════════════════════════════════ */

interface EggState {
  sweepSeq: number
  greenAt: number
  /** 灯塔扫一次（夜航解锁 / 手动切主题时用） */
  bumpSweep: () => void
  /** 测试全绿：扫一次 + 起绿线 */
  celebrateGreen: () => void
}

export const useEggStore = create<EggState>((set) => ({
  sweepSeq: 0,
  greenAt: 0,
  bumpSweep: () => set((s) => ({ sweepSeq: s.sweepSeq + 1 })),
  celebrateGreen: () => set((s) => ({ sweepSeq: s.sweepSeq + 1, greenAt: Date.now() })),
}))
