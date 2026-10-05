import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   工具自己报的进度怎么落到那条记录上（真机反馈 9a）

   抽出来是因为 `streamEvents.ts` 一直贴着 300 行（硬约束 #2），
   而这一块自己就完整：进度事件一秒可能来好几次，**只改那一条记录** ——
   rounds 不用重建（里面存的是下标，别的什么都没变）。

   ⚠️ 这是个**纯函数**（就地改 `runs`），调用方负责把新数组交给 state：
       if (applyToolProgress(state.toolRuns, event)) state.patch({ toolRuns: [...state.toolRuns] })
   ══════════════════════════════════════════════════════════════ */

/** 返回值：找到了那条记录并写进去了（false = 这条进度不认识，调用方别白重渲） */
export function applyToolProgress(runs: ToolRunRecord[], event: Record<string, unknown>): boolean {
  const id = String(event.toolCallId ?? '')
  const index = runs.findIndex((run) => run.id === id)
  const current = runs[index]
  if (index < 0 || !current) return false

  runs[index] = {
    ...current,
    progress: {
      /* 报不出百分比就是 null —— 「还在动」和「0%」是两件事，界面也别画成一样 */
      percent: typeof event.percent === 'number' ? event.percent : null,
      note: String(event.note ?? ''),
    },
  }
  return true
}
