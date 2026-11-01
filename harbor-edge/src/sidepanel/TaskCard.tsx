/**
 * M02-B：**任务卡**（对话区上方，有任务时才出现）
 *
 * ── 它解决什么 ─────────────────────────────────────────────────
 *
 * 侧边栏只有「消息流」时，用户看不出**现在在干什么**：
 * 是不是在跑？跑的是哪个工具？是不是**卡在等你确认**？
 * 主窗口那边有一整套（相位 / 工具 / 确认卡），侧边栏以前只能看到流式文字在动。
 *
 * ── 数据从哪来（★ 先回答这个再谈 UI）────────────────────────────
 *
 * 全部来自 `chat:event` 里**已经在推**的事件（`PUSH_TYPES`，见
 * `electron/core/ext-chat-streams.cjs`），**不新增任何 IPC 通道**、不自己问主进程。
 *
 *   · `turn_start`       → 第几轮
 *   · `plan`             → 计划条目数
 *   · `agent.tool.started` / `.completed` / `.failed` → 当前工具
 *   · `confirm_request`  → **等待你确认**（最需要显眼的一个状态）
 *   · `done` / `aborted` / `error` → 收尾，卡片消失
 *
 * ⚠️ 本文件**只负责画**。状态推导（认哪些事件、怎么累加）在
 *    `task-state.ts` —— 那是纯函数，自检能直接跑；两处各写一份必然漂。
 *
 * `ChatPanel.tsx` 已经 299 行（≤300 硬约束），所以卡片单列一个文件。
 */

import { Loader2, ShieldQuestion, Wrench } from 'lucide-react'
import { shouldShowTask, type TaskState } from './task-state'

/**
 * @param {{ state: TaskState }} props 状态由 `useChatStream` 累加（它已经在收事件）
 */
export function TaskCard({ state }: { state: TaskState }) {
  if (!shouldShowTask(state)) return null

  const parts: string[] = []
  if (state.turn > 0) parts.push(`第 ${state.turn} 轮`)
  if (state.planSteps > 0) parts.push(`计划 ${state.planSteps} 步`)
  const detail = parts.join(' · ')

  return (
    <div
      aria-label="任务卡"
      className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-base border border-line-hairline bg-bg-raised px-2 py-1 text-2xs"
    >
      {state.awaitingConfirm ? (
        <>
          <ShieldQuestion size={12} aria-hidden="true" className="shrink-0 text-warning" />
          <span aria-label="任务状态" className="truncate text-warning">
            等你确认 —— 去主窗口处理那张卡
          </span>
        </>
      ) : (
        <>
          {state.tool ? (
            <Wrench size={12} aria-hidden="true" className="shrink-0 text-fg-tertiary" />
          ) : (
            <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-fg-tertiary" />
          )}
          <span aria-label="任务状态" className="truncate text-fg-secondary">
            {state.tool ? `在跑：${state.tool}` : '正在回复…'}
          </span>
        </>
      )}
      {detail ? (
        <span aria-label="任务详情" className="ml-auto shrink-0 text-fg-tertiary">
          {detail}
        </span>
      ) : null}
    </div>
  )
}
