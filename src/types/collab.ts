/**
 * 双模型协作的类型（2026-10-17）
 *
 * 与主进程 `handlers/collab.cjs` 的 `status()` / `core/collab.cjs` 的返回**一一对应**
 * （硬约束 9：形状只有一处真相源）。这里只做 TypeScript 侧声明，判据全在主进程。
 *
 * A/B 模型选择由当前对话保存；状态接口只描述能力与可用性。
 */

/** 一个角色（A = 规划/验收，B = 执行） */
export interface CollabRole {
  id: string
  label: string
  duty: string
  /** 能胜任这个角色的后端 kind 集合（能力声明） */
  kinds: string[]
}

/** 主进程算好的状态（界面照它显示，不自己判断） */
export interface CollabState {
  enabled: boolean
  roles: Record<string, CollabRole>
  /** 每个后端 kind 现在能不能用（codex-cli / openai）—— 界面据此过滤禁用 */
  matrix: Record<string, boolean>
  ready: boolean
  /** 缺哪些前提（每一条都是人话，直接显示） */
  blockers: string[]
  codex: { ready: boolean; note: string }
  projectTests: { enabled: boolean; count: number }
}

/** Codex 的计划（四个字段缺一不可） */
export interface CollabPlan {
  problem: string
  scope: string[]
  expected: string
  verify: string
}

/** DeepSeek 执行的真实痕迹（来自 toolRuns，不是模型自述） */
export interface CollabTrace {
  writes: string[]
  lastTest: { status: string; exitCode: number | null; testId: string } | null
  executionId: string
  tools: Array<{ name: string; ok: boolean }>
}

/** Codex 的验收结论（只认三个值） */
export interface CollabReview {
  verdict: 'PASS' | 'NEEDS_CHANGES' | 'BLOCKED' | string
  reasons: string[]
  issues: string[]
}

/** 一次协作的返回 */
export interface CollabRunResult {
  ok: boolean
  code?: string
  message?: string
  plan?: CollabPlan
  trace?: CollabTrace
  review?: CollabReview
  report?: string
  phases?: string[]
  accepted?: boolean
}
