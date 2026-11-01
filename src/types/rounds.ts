/**
 * 时间线 / 工具记录的类型（2026-10-21 从 conversation.ts 拆出 —— 那边贴到 300 行红线）
 *
 * 这些类型和 `Message` 是两件事：`Message` 是「一条消息」，这里是「这一条消息内部
 * 按时间发生了什么」。拆开之后两边都能再长，不用为了挪一行去动另一份。
 *
 * 对外仍然从 `@/types` 导出（`types/index.ts` 有 re-export），所以 import 路径不用改。
 */

/**
 * 一轮里的片段（时间线渲染用）—— 顺序就是真实发生顺序。
 *
 * `tools` 存的是 `Message.toolRuns` 里的**下标**，不重复存工具记录本身
 * （否则同一份输出要在会话文件里存两遍）。
 */
export interface MessageRound {
  reasoning: string
  content: string
  /** 这一轮跑过的工具（`Message.toolRuns` 的下标） */
  tools: number[]
}

/** 一次工具调用的记录 */
export interface ToolRunRecord {
  id: string
  name: string
  /** 参数摘要，展示用 */
  summary?: string
  ok: boolean
  output: string
  ms?: number
  /**
   * 长任务自己报的进度（真机反馈 9a）。
   * `percent: null` = 只知道还在动、报不出百分比 —— 界面别把这两种画成一样。
   * 只在跑的时候有值（收尾后记录里不再需要它）。
   */
  progress?: { percent: number | null; note: string }
  /**
   * 子代理（v1）：这次 `spawn_subagent` 调用**内部**干了什么。
   * 只有 `spawn_subagent` 那条记录会带上它；形状见 `SubagentTrace`。
   */
  subagent?: SubagentTrace
}

/**
 * 子代理内部的一步（界面画卡片用）。
 *
 * ★ 只留「做了什么」——`tool` + `args`，**不留它读到的内容**。两个理由：
 *   ① 那些原文本来就不该进父任务的上下文 / 会话文件（上下文隔离正是子代理的意义）；
 *   ② 全存下来会把会话文件撑爆（一次读 7 份文档就是几百 KB）。
 */
export interface SubagentStep {
  /** 子代理**自己**的 toolCallId —— 把 started / completed 认成同一行 */
  id: string
  at: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  ms?: number
  /** started = 正在跑（界面转圈）；completed / failed = 收尾 */
  phase: 'started' | 'completed' | 'failed'
}

/** 这一次 `spawn_subagent` 调用内部跑了什么（卡片的数据源） */
export interface SubagentTrace {
  /** 子任务台账 id —— 想深看可以去 `data/tasks/` 找它 */
  taskId: string
  /** 派它去干什么（父给的那句话） */
  goal: string
  status: 'running' | 'completed' | 'failed'
  /** 收尾时子代理自己报的轮数 */
  turns?: number
  steps: SubagentStep[]
}
