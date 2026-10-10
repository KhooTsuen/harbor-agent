/* ══════════════════════════════════════════════════════════════
   安全与可靠：类型（从 safety.ts 拆出来的）

   纯类型声明 —— 「桥」（ProfileBridge / SafetyBridge）留在 safety.ts。
   拆开是因为两边改的理由不同：加一个字段 = 动这里；加一个 IPC 方法 = 动那边。
   ══════════════════════════════════════════════════════════════ */

import type { DiffFile } from './index'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type PolicyAction = 'allow' | 'ask' | 'block'

export type ShellPolicy = {
  medium: PolicyAction
  high: PolicyAction
  critical: PolicyAction
}

export interface MemoryConfig {
  autoWrite: 'auto' | 'ask' | 'off'
  injectLimit: number
  maxItems: number
  retrieve: boolean
}

export interface ContextConfig {
  baseTokens: number // 上下文基准（token）：0 = 跟随模型窗口；非 0 = 用户钉死的上限；与 assistant.maxTokens（输出上限）无关
  budget: Record<string, number>
  compactAt: number
  autoCompactAt: number
}

export interface RouterConfig {
  enabled: boolean
  roles: { fast: string; reasoning: string; coding: string; vision: string; cheap: string }
}

export interface FallbackConfig {
  enabled: boolean
  attempts: number
  retryOn: string[]
}

export interface AuditConfig {
  enabled: boolean
  retentionDays: number
}

export interface AuditEntry {
  ts: number
  sessionId: string
  taskId: string
  tool: string
  args?: unknown
  permission: string
  approval: boolean | null
  startedAt: number
  finishedAt: number
  ms: number
  ok: boolean
  error: string
  affectedFiles: string[]
  networkTarget: string
  result?: string
  extras?: { risk?: RiskVerdict }
}

export interface AuditStats {
  days: number
  total: number
  failed: number
  denied: number
  byTool: Record<string, number>
}

export interface RiskVerdict {
  level: 'low' | 'medium' | 'high' | 'critical'
  reasons: string[]
  network: boolean
  writes: boolean
  installs: boolean
  elevation: boolean
  opaque: string[]
  command: string
}

export interface CapabilityGrant {
  path: string
  mode: 'once' | 'session' | 'permanent'
  reason: string
  grantedAt: number
  expiresAt: number
}

/**
 * AG-037：一轮跑完的性能时间线（内核给的）。
 * `*Ms` 是「按下发送」起算的延迟；`contextMs / llmMs / toolMs / searchMs` 是各段自己的
 * 总耗时 —— 合起来能回答「这一轮慢在哪一段」。缺哪段就是 0，不编。
 */
export interface PerfTimeline {
  traceId: string
  requestTime: number
  /** 按下发送 → 第一条事件（这段时间用户面对的是「没反应」） */
  firstFeedbackMs: number | null
  /** 按下发送 → 任务台账建好 */
  taskCreatedMs: number | null
  /** 按下发送 → 模型吐出第一个字 */
  ttftMs: number | null
  /** 按下发送 → 第一次工具开始 */
  firstToolMs: number | null
  /** 按下发送 → 整轮结束 */
  totalMs: number | null
  contextMs: number
  llmMs: number
  llmCalls: number
  /** 单次模型调用里最慢的那次 */
  llmMaxMs: number
  toolMs: number
  toolCalls: number
  searchMs: number
  searchCalls: number
}

/**
 * AG-036：最近一批改动的 diff。
 *
 * 数据来自改动事务的「改动前快照」和磁盘当前内容 —— 所以「改了什么」是**真**比出来的，
 * 不是模型说的。`skipped` 是没算进 diff 的文件及原因（快照丢了 / 一次改太多）。
 */
export interface ChangeSetDiff {
  id: string
  title: string
  taskId: string
  sessionId: string
  status: string
  at: number
  files: DiffFile[]
  additions: number
  deletions: number
  skipped: string[]
}

export interface ChangeSetSummary {
  id: string
  taskId: string
  sessionId: string
  title: string
  status: string
  startedAt: number
  finishedAt: number
  fileCount: number
  files: string[]
}

export interface CredentialsStatus {
  encryptionAvailable: boolean
  backend: 'safeStorage' | 'plain'
  count: number
  file: string
}

export interface MemoryItem {
  id: string
  content: string
  type:
    | 'preference'
    | 'fact'
    | 'workflow'
    | 'project_rule'
    | 'constraint'
    | 'decision'
    | 'temporary'
    | 'habit'
    | 'instruction'
  scope: 'global' | 'project' | 'workspace' | 'task' | 'session'
  source: 'user_explicit' | 'user_confirmed' | 'model_suggested' | 'imported' | 'system'
  confidence: number
  importance: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  expiresAt: number
  projectId: string
  status: 'active' | 'superseded' | 'disabled' | 'expired'
  supersededBy: string
}

export interface MemoryStats {
  total: number
  active: number
  disabled: number
  superseded: number
  byType: Record<string, number>
  byScope: Record<string, number>
  maxItems: number
}
