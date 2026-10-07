/**
 * 聊天事件 type 的**一处清单**（P0-7 Event Contract 的**主进程侧**）
 *
 * 主进程把所有 Agent 事件经**一条通道**（`chat:event`）推给渲染层，靠 `type` 区分。
 * 以前「主进程会发哪些 type」只散落在各个 `emit(...)` 调用点里 ——
 * 想知道全貌得挨个模块翻，改了漏登记也没人报红（典型「同一件事写两份」，硬约束 9）。
 *
 * 这个文件把那份清单**定死在一处**：
 *
 *   · `AGENT_EVENTS`     —— 生命周期标准名（文档 AG-002 那 16 个）。
 *     以前定义在 `events.cjs`，现在搬到这里、由它 require（避免两套真值）。
 *     渲染层有一份**镜像**（`src/types/events.ts`），自检 `126-event-types` 逐字比对。
 *   · `CHAT_EVENT_TYPES` —— 推给渲染层的**全集**（生命周期 + 流式增量 + 决策卡 +
 *     一轮结束 + 提示类 + 调试信息）。渲染层认得的集合必须与它一致。
 *
 * ★ 这不是「第二套真值」：真正的处理逻辑不在这里 —— 主进程在各自模块里 `emit`、
 *   渲染层在 `stores/thread/*.ts` 里 `case`。这里只声明**名字**，两端靠自检对齐
 *   （自检同时钉「主进程所有 emit 的 type ⊆ 本清单」）。
 *
 * 加一种新事件时：**先在这里登记**，再写 emit 与 case —— 忘了登记自检报红。
 */

/** 文档 AG-002 列的标准事件名。生命周期事件只用这些。 */
const AGENT_EVENTS = [
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
]

/**
 * 主进程推给渲染层的 type 全集。
 *
 * 分档（改这里时每档都要顾及）：
 *   · **生命周期** —— `phase`（相位事件，payload 带 `phase`）+ 上面 16 个 `agent.*`
 *   · **流式增量** —— 正文 / 思考，走批处理（20 条/秒）
 *   · **工具 / 子代理 / 回合** —— 工具进度、子代理内部步、回合分段
 *   · **决策卡（P0-5）** —— 发出 / 两类卡超时作废
 *   · **一轮结束** —— done / aborted / error
 *   · **附件 / 提示 / 降级** —— 长消息落文件、能力边界、预算、失败分类、降级、压缩……
 *   · **调试信息** —— 意图分类与模型选择（渲染层有意不落消息）
 */
const CHAT_EVENT_TYPES = [
  /* 生命周期 */
  'phase',
  ...AGENT_EVENTS,

  /* 流式增量 */
  'content',
  'reasoning',

  /* 工具 / 子代理 / 回合 */
  'subagent.step',
  'turn_start',
  'turn_end',

  /* 决策卡：发出 / 两类卡超时作废 */
  'confirm_request',
  'confirm.timeout',
  'clarify.timeout',

  /* 一轮结束 */
  'done',
  'aborted',
  'error',

  /* 附件 / 提示 / 降级 / 循环 / 压缩 */
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

  /* 调试信息：意图分类与模型选择 */
  'mode',
  'route',
]

module.exports = { AGENT_EVENTS, CHAT_EVENT_TYPES }
