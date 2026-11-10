/**
 * 双模型协作的类型（2026-10-17）
 *
 * 与主进程 `handlers/collab.cjs` 的 `status()` / `core/collab.cjs` 的返回**一一对应**
 * （硬约束 9：形状只有一处真相源）。这里只做 TypeScript 侧声明，判据全在主进程。
 *
 * A/B 模型选择由当前对话保存；状态接口只描述能力与可用性。
 */

import type { CollaborationRecord, CollabLimits } from './collaboration'
export type { CollabLimits } from './collaboration'

export interface CollabSettings extends CollabLimits {
  enabled: boolean
}

/** 一个角色（A = 规划/检查/交付，B = 执行） */
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
  connections?: Record<string, { ready: boolean; reason: string; executorReady?: boolean }>
  ready: boolean
  /** 缺哪些前提（每一条都是人话，直接显示） */
  blockers: string[]
  codex: { ready: boolean; note: string }
  projectTests: { enabled: boolean; count: number }
  limits?: CollabLimits
}

/** 计划与检查形状复用持久化记录的定义。 */
export type CollabPlan = NonNullable<CollaborationRecord['plan']>

/** 执行的真实痕迹（来自 toolRuns，不是模型自述） */
export interface CollabTrace {
  changedAfterTest?: boolean
  writes: string[]
  lastTest: { status: string; exitCode: number | null; testId: string } | null
  executionId: string
  tools: Array<{ id?: string; name: string; ok: boolean; output?: string; pending?: boolean }>
}

export type CollabReview = NonNullable<CollaborationRecord['review']>

/** 一次协作的返回 */
export interface CollabRunResult {
  taskId?: string
  collaboration?: import('./collaboration').CollaborationRecord
  toolRuns?: import('./rounds').ToolRunRecord[]
  ok: boolean
  code?: string
  message?: string
  plan?: CollabPlan
  trace?: CollabTrace
  review?: CollabReview
  finalContent?: string
  report?: string
  phases?: string[]
  accepted?: boolean
}
