/* ══════════════════════════════════════════════════════════════
   安全与可靠：类型

   从 backend.ts / models.ts 拆出来的 —— 加完审计、授权、任务、
   改动事务之后，那两个文件都过 300 行了。
   ══════════════════════════════════════════════════════════════ */

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
  status: 'active' | 'superseded' | 'disabled'
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

/* ══════════════════════════════════════════════════════════════
   桥上的安全 / 可靠方法

   从 backend.ts 拆出来（那边超过 300 行了）。
   WorkbenchBridge 通过 extends 把它们合回去 ——
   调用方看到的还是一个完整的桥。
   ══════════════════════════════════════════════════════════════ */

/* 任务那摊方法在 task.ts 的 TaskBridge 里（见那边的说明） */
/* 个人资料（头像 + 名字）：名字进配置、头像进 data/avatars/（二进制不塞 config） */

export interface ProfileBridge {
  /** 名字 + 头像（data URL；没设过就是空串） */
  profileGet: () => Promise<{ ok: boolean; name: string; avatar: string }>
  profileSetName: (name: string) => Promise<{ ok: boolean; name: string }>
  /** 弹系统选图框 → 存进 data/avatars/ → 回新的 data URL */
  profilePickAvatar: () => Promise<{
    ok: boolean
    canceled?: boolean
    avatar?: string
    error?: string
  }>
  profileClearAvatar: () => Promise<{ ok: boolean; avatar: string }>
}

export interface SafetyBridge extends TaskBridge, ProfileBridge {
  /* ── 结构化记忆 ─────────────────────────────────────── */

  memoryList: (options?: {
    status?: string
    scope?: string
    type?: string
    projectId?: string
    includeSuperseded?: boolean
  }) => Promise<{ ok: boolean; items: MemoryItem[] }>
  memorySearch: (
    query: string,
    options?: { projectId?: string; includeSuperseded?: boolean },
  ) => Promise<{ ok: boolean; items: MemoryItem[] }>
  memoryAdd: (input: Partial<MemoryItem>) => Promise<{
    ok: boolean
    item?: MemoryItem
    error?: string
    deduped?: boolean
  }>
  memoryUpdate: (payload: { id: string; patch: Partial<MemoryItem> }) => Promise<{
    ok: boolean
    item?: MemoryItem
    error?: string
  }>
  memoryDisable: (id: string) => Promise<{ ok: boolean }>
  memoryEnable: (id: string) => Promise<{ ok: boolean }>
  memoryRemove: (id: string) => Promise<{ ok: boolean; stats?: MemoryStats }>

  /* ── 审计 / 授权 / 任务 / 改动事务 ─────────────────────── */

  auditList: (options?: {
    day?: string
    limit?: number
    sessionId?: string
    tool?: string
    onlyProblems?: boolean
  }) => Promise<{ ok: boolean; entries: AuditEntry[]; days: string[] }>
  auditStats: (days?: number) => Promise<{ ok: boolean; stats: AuditStats }>
  auditClear: () => Promise<{ ok: boolean; removed: number }>
  auditPrune: () => Promise<{ ok: boolean; removed: number }>
  riskClassify: (command: string) => Promise<{
    ok: boolean
    verdict: RiskVerdict
    policy: Record<string, string>
    decide: { action: string }
  }>

  capabilityList: () => Promise<{ ok: boolean; grants: CapabilityGrant[] }>
  capabilityGrant: (payload: { path: string; mode?: string; reason?: string }) => Promise<{
    ok: boolean
    path?: string
    error?: string
  }>
  capabilityRevoke: (target: string) => Promise<{ ok: boolean; removed?: number }>
  capabilityRevokeAll: () => Promise<{ ok: boolean }>

  changesetList: (options?: { limit?: number; taskId?: string; sessionId?: string }) => Promise<{
    ok: boolean
    changesets: ChangeSetSummary[]
  }>
  /** AG-036：最近一批改动的 diff（右栏「审查」标签用）—— 纯读 */
  changesetDiff: (payload?: { sessionId?: string }) => Promise<{ ok: boolean; diff: ChangeSetDiff }>
  /** AG-037：最近几次的性能时间线（性能面板用）—— 纯读，读的是内存里的那几份 */
  metricsRecent: (payload?: { limit?: number }) => Promise<{ ok: boolean; items: PerfTimeline[] }>
  changesetGet: (id: string) => Promise<{ ok: boolean; changeset: Record<string, unknown> | null }>
  changesetRollback: (id: string) => Promise<{
    ok: boolean
    restored?: string[]
    removed?: string[]
    failed?: Array<{ path: string; reason: string }>
    error?: string
  }>

  credentialsStatus: () => Promise<{ ok: boolean; status: CredentialsStatus }>
}

import type { DiffFile } from './index'
import type { TaskBridge } from './task'

export type { TaskDiagnosis, TaskRecord, TaskRecoveryItem, TestStatusInfo } from './task'
