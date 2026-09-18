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

export interface TaskRecord {
  id: string
  title: string
  goal: string
  status: 'running' | 'waiting_user' | 'paused' | 'completed' | 'failed' | 'cancelled'
  mode: string
  sessionId: string
  projectId: string
  workdir: string
  plan: string[]
  /* AG-004：每一版计划（含当前版，最后一条就是现行的）。老任务没有 —— 当空数组看 */
  planVersions?: Array<{ plan: string[]; at: number; reason: string }>
  steps: Array<{ at: number; tool: string; ok: boolean; ms: number; summary: string }>
  checkpoints: Array<{ at: number; label: string; note: string }>
  changedFiles: Array<{ path: string; at: number }>
  commands: Array<{ command: string; result: string; at: number }>
  changeSetId: string
  errors: Array<{ at: number; message: string }>
  result: string
  createdAt: number
  updatedAt: number
  finishedAt: number
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

export interface SafetyBridge {
  /* ── 结构化记忆 ─────────────────────────────────────── */

  memoryList: (options?: {
    status?: string
    scope?: string
    type?: string
    includeSuperseded?: boolean
  }) => Promise<{ ok: boolean; items: MemoryItem[] }>
  memorySearch: (query: string) => Promise<{ ok: boolean; items: MemoryItem[] }>
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

  taskList: (options?: { limit?: number; status?: string; sessionId?: string }) => Promise<{
    ok: boolean
    tasks: TaskRecord[]
  }>
  taskUnfinished: () => Promise<{ ok: boolean; tasks: TaskRecord[] }>
  taskGet: (id: string) => Promise<{ ok: boolean; task: TaskRecord | null }>
  taskUpdate: (payload: { id: string; patch: Record<string, unknown> }) => Promise<{
    ok: boolean
    task?: TaskRecord
    error?: string
  }>
  taskRemove: (id: string) => Promise<{ ok: boolean }>
  taskPauseRunning: () => Promise<{ ok: boolean; paused?: number }>

  changesetList: (options?: { limit?: number; taskId?: string; sessionId?: string }) => Promise<{
    ok: boolean
    changesets: ChangeSetSummary[]
  }>
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
