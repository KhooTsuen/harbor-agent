/**
 * 工具跑完之后要顺带通知的两个外部列表（2026-10-21 从 streamEvents.ts 拆出）
 *
 * `streamEvents.ts` 贴着 300 行红线，而这两行本身是独立的一件事：
 * **消息状态变了，别的面板得知道**。
 *
 * ── 两条各自为什么存在 ──────────────────────────────────────
 *
 * ① **任务台账**（AG-005）：进度时间线的「动作行」读的是台账的 `steps`，
 *    而台账快照只在几个离散时机刷新 —— 工具执行期间 status 不变，时间线就
 *    永远看不到任何一步（真机抓到的；单测照不到这种接线）。
 *    走事件驱动、每个工具一次，量很小。
 *
 * ② **运行日志**：底栏那个日志以前只在打开时拉一次，工具跑完一条都不动。
 *
 * ⚠️ 两条都是 `void` 出去的（不 await）：落盘/刷新失败不该影响这一轮的事件处理，
 *    而它们各自的失败会自己进 `data/errors`。
 */
import { useTaskStore } from '@/stores/useTaskStore'
import { useAuditStore } from '@/stores/useAuditStore'

/** 工具跑完一次 → 让任务台账与运行日志各拉一次 */
export function refreshAfterTool(): void {
  void useTaskStore.getState().refresh()
  useAuditStore.getState().bump()
}
