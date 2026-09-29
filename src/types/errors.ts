/**
 * 「错误」标签的类型
 *
 * 为什么单独一个文件：`types/backend.ts` 和 `types/safety.ts` 都已经正好 300 行
 * （行数红线是全仓库硬约束）。新开一个文件放新的东西，比往那两个里硬塞更清爽。
 * 挂进 `WorkbenchBridge` 的方式见 `types/backend.ts` 的 extends 那一行。
 */

/** 严重性：P0 用不了 / P1 严重 / P2 一般 / P3 轻微 */
export type ErrorSeverity = 'P0' | 'P1' | 'P2' | 'P3'

/** 一条（合并后的）错误。同一条反复发生只占一行，次数在 `count` 里 */
export interface ErrorEntry {
  key: string
  /** 内核分类器的分类（network / auth / tool_failure …） */
  kind: string
  severity: ErrorSeverity
  /** 归一化过的消息（数字、临时 id 被抹成占位符） */
  message: string
  /** 一句人话建议 */
  hint: string
  /** 出错的环节：ipc / tool / model / mcp / pty */
  origin: string
  /** 能去查的坐标，如 `ipc:pty:resize` */
  location: string
  /** 首次出现（毫秒时间戳） */
  firstSeen: number
  /** 最后一次出现 */
  lastSeen: number
  /** 合并了几次（含观察哨折叠的重复计数） */
  count: number
  needsUser: boolean
  retryable: boolean
  /** 原始文本（已脱敏），给人看细节 */
  raw: string
  context: { tool: string; taskId: string; sessionId: string }
}

export interface ErrorStats {
  /** 看了最近几天 */
  days: number
  /** 真读到的文件数 / 目录里一共有几个 */
  files: number
  filesTotal: number
  lines: number
  /** 解析不出来的行数（有的话说明文件被写坏了） */
  badLines: number
  /** 原始条数 → 合并后几条 → 一共发生几次 */
  raw: number
  unique: number
  total: number
  bySeverity: Record<string, number>
  byKind: Record<string, number>
  byOrigin: Record<string, number>
  windowFrom: number | null
  windowTo: number | null
  elapsedMs: number
}

export interface ErrorListResult {
  ok: boolean
  dir: string
  severityOrder?: ErrorSeverity[]
  severityLabel?: Record<string, string>
  entries: ErrorEntry[]
  /** 条数超过上限被截断过 */
  truncated?: boolean
  stats: Partial<ErrorStats>
  /** 读失败时的原因（界面要说清楚，不能显示成「一切正常」） */
  reason?: string
}

/** 挂到 `window.workbench` 上的那几个方法 */
export interface ErrorsBridge {
  /** 读错误清单。只读、不会改任何数据 */
  errorsList: (options?: { days?: number; limit?: number }) => Promise<ErrorListResult>
}
