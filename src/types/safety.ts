/* ══════════════════════════════════════════════════════════════
   安全与可靠的「桥」

   从 backend.ts 拆出来（那边超过 300 行了）。
   WorkbenchBridge 通过 extends 把它们合回去 —— 调用方看到的还是一个完整的桥。
   纯类型声明（RiskLevel / AuditEntry / MemoryItem …）搬到了 safety-types.ts，这里转出去。
   ══════════════════════════════════════════════════════════════ */

import type { TaskBridge } from './task'
import type {
  AuditEntry,
  AuditStats,
  CapabilityGrant,
  ChangeSetDiff,
  ChangeSetSummary,
  CredentialsStatus,
  MemoryItem,
  MemoryStats,
  PerfTimeline,
  RiskVerdict,
} from './safety-types'

export * from './safety-types'

/* ══════════════════════════════════════════════════════════════
   桥上的安全 / 可靠方法

   从 backend.ts 拆出来（那边超过 300 行了）。
   WorkbenchBridge 通过 extends 把它们合回去 ——
   调用方看到的还是一个完整的桥。
   ══════════════════════════════════════════════════════════════ */

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

export type { TaskDiagnosis, TaskRecord, TaskRecoveryItem, TestStatusInfo } from './task'
