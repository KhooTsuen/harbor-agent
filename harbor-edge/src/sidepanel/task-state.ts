/**
 * M02-B：**任务卡的状态推导**（纯函数，不碰 React、不碰 chrome）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────
 *
 * ① 它是**纯逻辑**：给一条 `chat:event`、算出卡片该显示什么。纯逻辑放独立文件
 *    才能被自检直接跑（`scripts/selftest/groups/176-m02b-cards.mjs`），而组件文件
 *    里塞着 JSX、`require` 不进来。
 * ② 消费方有两个：`TaskCard.tsx`（只管画）与 `useChatStream.ts`（收事件时累加）。
 *    放组件里会形成「hook 反向依赖组件」的怪方向。
 *
 * ── 事件名必须是渲染层真实发出的那些 ───────────────────────────
 *
 * 2026-10-20 查出一个**静默失效**：`ext-chat-streams.cjs` 的 `PUSH_TYPES` 原来写
 * `tool_start` / `tool_end`，而渲染层实际发的是 `agent.tool.started` /
 * `agent.tool.completed`（见 `src/types/chat-events.ts`）——
 * 永远命中不了，而且**不报任何错**，只是卡片上的工具名一直不出现。
 * 现在两边都认，`PUSH_TYPES` 也已补齐（自检 `175` 有一条判据钉「真名对齐」）。
 */

/** 卡片要展示的状态（全部从事件推导，不额外问主进程） */
export interface TaskState {
  /** 在跑（收到 turn_start 且还没 done） */
  running: boolean
  /** 第几轮（0 = 还不知道） */
  turn: number
  /** 当前在跑的工具名（空 = 没有） */
  tool: string
  /** 正在等待用户确认（最需要显眼的一个状态） */
  awaitingConfirm: boolean
  /** 计划条目数（0 = 没规划） */
  planSteps: number
}

/** 空状态（一轮结束就回到它） —— 每次给**新对象**，别让调用方共享同一个引用 */
export function emptyTask(): TaskState {
  return { running: false, turn: 0, tool: '', awaitingConfirm: false, planSteps: 0 }
}

/**
 * 从一条 `chat:event` 推导出新的卡片状态。
 *
 * 认不出的事件**原样返回同一个对象**（调用方可以据此跳过 setState，省一次渲染）。
 *
 * @param {TaskState} prev
 * @param {{ type?: string, [k: string]: unknown }} event
 * @returns {TaskState}
 */
export function nextTaskState(prev: TaskState, event: { type?: string; [k: string]: unknown }): TaskState {
  const type = String(event?.type ?? '')
  if (!type) return prev
  switch (type) {
    case 'turn_start':
      return {
        ...prev,
        running: true,
        turn: Number(event.turn ?? prev.turn) || prev.turn,
        tool: '',
        awaitingConfirm: false,
      }
    case 'plan': {
      const steps = Array.isArray(event.plan) ? event.plan.length : 0
      return { ...prev, planSteps: steps }
    }
    case 'agent.tool.started':
    case 'tool_start':
      /* 工具名可能叫 name / tool / id —— 三个都认（渲染层历史上用过不同字段） */
      return { ...prev, tool: String(event.name ?? event.tool ?? event.id ?? '工具') }
    case 'agent.tool.completed':
    case 'agent.tool.failed':
    case 'tool_end':
      return { ...prev, tool: '' }
    case 'confirm_request':
      return { ...prev, awaitingConfirm: true }
    case 'done':
    case 'aborted':
    case 'error':
      /* 一轮结束：卡片收掉（确认态也一起清，否则会永远挂着「等你确认」） */
      return emptyTask()
    default:
      return prev
  }
}

/** 卡片该不该显示：没在跑就不占位置 */
export function shouldShowTask(state: TaskState): boolean {
  return state?.running === true
}
