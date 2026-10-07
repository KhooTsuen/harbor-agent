/* ══════════════════════════════════════════════════════════════
   事件类型登记表（P0-7 Event Contract 的**渲染层侧**）

   主进程把所有 Agent 事件经**一条通道**（`chat:event`）推过来，靠 `type` 区分。
   以前渲染层拿到的是一串裸字符串，两边各写各的 —— 这个文件是渲染层侧的
   **一处清单**，回答「我们认得哪些 type」。

   两侧对齐的真相源在**主进程**：`electron/core/event-types.cjs` 的 `AGENT_EVENTS`
   （生命周期 16 个标准名）与 `CHAT_EVENT_TYPES`（type 全集）。这里的 `AGENT_EVENTS`
   与 `EVENT_TYPES` 是它们的**镜像** —— 自检 `126-event-types` 从两边源码抠出来
   **断言相等**（谁改了忘同步就报红）。

   ⚠️ 这不是「第二套真值」：处理逻辑仍在 `stores/thread/*.ts`（`handleStreamEvent`
   等）；这里只声明**名字**，自检同时钉「消费点的 case ⊆ 本清单」。
   ══════════════════════════════════════════════════════════════ */

/** 生命周期标准名 —— 与 `electron/core/event-types.cjs` 的 `AGENT_EVENTS` 逐字一致 */
export const AGENT_EVENTS = [
  'agent.started',
  'agent.thinking',
  'agent.planning',
  'agent.tool.started',
  'agent.tool.progress',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.verification.started',
  'agent.verification.completed',
  'agent.waiting_user',
  'agent.retrying',
  'agent.paused',
  'agent.resumed',
  'agent.cancelled',
  'agent.completed',
  'agent.failed',
] as const

/**
 * 渲染层认得的 type 全集。
 *
 * 分三档（改这里时三档都要顾及）：
 *   · **处理** —— `handleStreamEvent`（或其子模块）有对应 case
 *   · **忽略** —— 主进程会发，但渲染层有意不处理（进度靠 phase、台账走 IPC 等）
 *   · **生命周期** —— `phase` 字段是相位值；`agent.*` 由 `isLifecycleEvent` 通配收下
 */
export const EVENT_TYPES = [
  /* 生命周期：相位事件（payload.phase）+ agent.* 标准名 */
  'phase',
  ...AGENT_EVENTS,

  /* 流式增量（走批处理，20 条/秒） */
  'content',
  'reasoning',

  /* 工具 / 子代理 */
  'subagent.step',

  /* 回合分段 */
  'turn_start',
  'turn_end', // 有意忽略：进度靠 phase 体现

  /* 决策卡（P0-5）：发出 / 两类卡超时作废 */
  'confirm_request',
  'confirm.timeout',
  'clarify.timeout',

  /* 一轮结束 */
  'done',
  'aborted',
  'error',

  /* 附件 / 提示 / 降级 */
  'attachment',
  'boundary',
  'budget',
  'notice',
  'retry',
  'fallback',
  'context_overflow',
  'review',
  'plan',
  'loop',
  'compacted',

  /* 有意忽略：意图分类与模型选择（调试信息），台账走 IPC 不走事件流 */
  'mode',
  'route',
] as const

export type AgentEventType = (typeof EVENT_TYPES)[number]
