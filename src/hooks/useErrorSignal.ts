import { useEffect } from 'react'
import { useErrorsStore } from '@/stores/useErrorsStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   错误角标的**触发**（Phase 1 · A1）

   内核没有「有新错误」的推送事件（加推送要动 IPC 契约，本轮不做），
   所以角标数据只能按**事件触发**去抓 —— 刻意不用定时器：

     · 挂载时抓一次（应用刚起来）
     · 窗口重新可见 / 获得焦点时抓一次（用户切回来，和任务中心同一套节流）
     · 任一条对话「在跑 → 空闲」时抓一次（一轮跑完最可能刚记下新错误）

   依赖 `runningCount`：它一变（开始/结束一轮）就重挂 effect、顺带抓一次。
   空闲时**没有任何定时器**，不会重复读盘。

   ⚠️ 已知时延：内核错误观察哨是**攒着 + 15 秒定时 flush**（`error-observer.cjs`），
   刚发生的错误可能要十几秒后才落到 `data/errors/*.jsonl`。所以角标不是「瞬间」
   亮起 —— 它会在下一次触发点（再跑一轮 / 切回窗口 / 重开应用）时亮。
   要「立刻亮」得让内核在一轮结束时 flush（属 Runtime 改动，本轮不做，已写进报告）。
   ══════════════════════════════════════════════════════════════ */

export function useErrorSignal(): void {
  const runningCount = useThreadStore((s) => s.sendingThreads.length)

  useEffect(() => {
    if (!useRealBackend) return
    const refresh = useErrorsStore.getState().refresh
    const refreshVisible = (): void => {
      if (!document.hidden) void refresh()
    }
    refreshVisible()
    document.addEventListener('visibilitychange', refreshVisible)
    /* 窗口重新获得焦点也抓一次 —— 比 visibilitychange 更常触发，且同样不是轮询 */
    window.addEventListener('focus', refreshVisible)
    return () => {
      document.removeEventListener('visibilitychange', refreshVisible)
      window.removeEventListener('focus', refreshVisible)
    }
  }, [runningCount])
}
