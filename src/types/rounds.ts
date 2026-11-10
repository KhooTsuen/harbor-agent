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
  sourcePath?: string
  retryOf?: string
  retryAttempt?: number
  retryingBy?: string
  recoveredBy?: string
  /** 参数摘要，展示用 */
  summary?: string
  ok: boolean
  output: string
  ms?: number
  /**
   * 这次调用**还没拿到结果**（2026-11-09）。
   *
   * 为什么需要：`agent.tool.started` 建记录时 `ok` 只能先乐观填 `true`（那时还不知道
   * 成败）。若进程在工具跑完前被强杀，磁盘快照里就是「一条 ok:true 的工具」——
   * 重启后界面画成**成功绿勾**，而这次调用的结果其实未知（可能写了一半文件）。
   *
   * 所以：started 时置 `pending: true`，completed / failed 时**删掉它**。
   * 读回后 `pending === true` 就是「跑了，但不知道结果」，界面必须如实说。
   * 老记录没有这个字段 → 当 false 看（它们至少走完了收尾那条路）。
   */
  pending?: boolean
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
  /**
   * 失败事实（2026-11-02，蓝图阶段 A）。成功时**没有这个键**。
   * 有了它，界面不用再从 `output` 里找 `[退出码 N]` —— 那正是这次要根治的猜法。
   */
  error?: ToolFailure
}

/**
 * 一次工具调用的**失败事实**（errorFeature 的最小可落盘形态）。
 *
 * ★ 形状的唯一真相源是 `electron/core/tool-failure.cjs` 的 `SHAPE_KEYS`，
 *   这里的字段名与那边逐字一致（自检 `191-tool-failure-fact` 做集合比对）。
 *   为什么不再各写一套：以前内核发了 `errorKind` / `errorHint`，而
 *   `chat-events.ts` 里两个字段都没声明 —— 事件从 `unknown` 进来，tsc 不报错，
 *   于是「界面能不能用上」全靠人记得去读内核代码。
 *
 * ── 三个容易搞错的点 ──
 *
 * 1. **`exitCode: 0` 与 `null` 不是一回事**：0 = 进程正常结束；
 *    null = 这次根本没有退出码（超时 / 中断 / 命令没起来）。
 * 2. **`reasonCode` 才是「为什么失败」**，别再从正文里找 `[退出码 N]`。
 * 3. 成功时**没有 `error` 这个键**（不是 `null`），老会话记录里也没有。
 */
export interface ToolFailure {
  /** 形状版本 —— 读的人按它判断认不认得 */
  schemaVersion: number
  reasonCode: FailureReason
  /** 进程退出码；`null` = 这次没有退出码（不是 0） */
  exitCode: number | null
  /** 系统错误码（ENOENT / EACCES…）；现在还取不到，如实为 null */
  systemCode: string | null
  /** `errors.cjs` 的分类名 */
  kind: string
  /** 一句话说明（来自分类表，不是模型编的） */
  hint: string
  /** 检索用的粗标签（蓝图 §4） */
  category: string
  /** 这次操作碰的是什么：code / web / file / research / other */
  domain: string
  retryable: boolean
  needsUser: boolean
}

/** 原因码 —— 与 `tool-failure.cjs` 的 `REASON` 一一对应（自检钉着） */
export type FailureReason =
  | 'EXIT_CODE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'DENIED'
  | 'FILE_NOT_FOUND'
  | 'PERMISSION'
  | 'NETWORK'
  | 'ASSERTION_FAILED'
  | 'TOOL_ERROR'
  | 'UNKNOWN'

/**
 * 这个值是不是一条失败事实？
 *
 * 事件从主进程是 `Record<string, unknown>` 进来的，不守卫就没法安全地挂到
 * `ToolRunRecord.error` 上（硬约束：外部数据进来先过校验，禁 any / ts-ignore）。
 * 判据只认**必需的那个字段**：`reasonCode` 是字符串。其余字段都有一处默认值，
 * 缺了不影响「这是不是失败」这个判断。
 */
export function isToolFailure(value: unknown): value is ToolFailure {
  if (value === null || typeof value !== 'object') return false
  const reason = (value as { reasonCode?: unknown }).reasonCode
  return typeof reason === 'string' && reason.length > 0
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
