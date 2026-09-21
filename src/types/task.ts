/* ══════════════════════════════════════════════════════════════
   任务台账的类型（AG-035 从 safety.ts 拆出来）

   那边 308 行贴顶了，而「任务」本来就是一摊独立的东西：任务是什么
   （TaskRecord）、能不能接着做（TaskRecoveryItem）、出了什么事
   （TaskDiagnosis）。安全/审计那些类型留在 safety.ts。
   ══════════════════════════════════════════════════════════════ */

/**
 * AG-035 的诊断报告。
 *
 * `text` 是给人看的整篇（可直接复制走），`conclusion` 是那一句结论 ——
 * 界面可以只用结论（一行），也可以展开看全部。
 */
export interface TaskDiagnosis {
  title: string
  status: string
  conclusion: string
  text: string
}

/**
 * AG-040：一个任务的执行预算（五项都可以留空 = 用设置里的默认）。
 * `0` 表示不限。
 */
export interface TaskBudget {
  maxSteps?: number
  maxToolCalls?: number
  maxRuntime?: number
  maxRetries?: number
  maxTokens?: number
}

/**
 * AG-041：转圈停下来时的证据。
 * `kind` = 'repeat'（同一个调用连着来）| 'cycle'（A B A B 这种周期）
 */
export interface LoopHit {
  kind: string
  period: number
  count: number
  samples: string[]
}

/** 撞预算时记下来的数字（界面原样显示「50 / 50」） */
export interface BudgetHit {
  reason: string
  label: string
  used: number
  limit: number
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
  /** AG-012：下一步要做的（计划里第一条没打勾的）—— 重启恢复时给用户看 */
  nextAction?: string
  /** AG-011/012：什么时候停的、恢复过几次 */
  pausedAt?: number
  resumeCount?: number
  /** AG-040：这个任务自己的预算覆盖；`budgetResolved` 是主进程算好的实际值 */
  budget?: TaskBudget
  budgetResolved?: Required<TaskBudget>
  /** 停下来的原因（'budget' = 撞了执行上限，不是失败） */
  pauseReason?: string
  pauseDetail?: string
  /** 撞预算那一下的数字 */
  budgetHit?: BudgetHit | null
  /** AG-041：转圈那一下的证据 */
  loopHit?: LoopHit | null
  /** AG-042：控制台显示的「这一轮烧了多少 token / 自动重试了几次」 */
  tokens?: number
  retries?: number
  /** AG-043：用户在任务执行中改过方向的记录 */
  steering?: Array<{ at: number; text: string }>
  /** AG-035：用户批过/拒过的操作（AG-013 起就在记，这里补上类型） */
  permissions?: Array<{
    at: number
    kind: string
    name?: string
    approved?: boolean
    auto?: boolean
  }>
  /** AG-035：这个任务用过的模型（按先后） */
  model?: string
  models?: string[]
  createdAt: number
  updatedAt: number
  finishedAt: number
}

/**
 * AG-012：一条「重启后可以接着做」的任务 —— 就是 TaskRecord 再**附加**三样
 * 界面做决定需要的东西：停手后环境变没变、计划走到哪、能不能恢复。
 *
 * 直接基于 TaskRecord 扩展（而不是另写一份精简结构）是因为界面要用
 * `steps` / `plan` / `planVersions` 渲染时间线和计划 —— 否则还得再拉一次。
 */
export type TaskRecoveryItem = TaskRecord & {
  /** 停手之后被别的东西动过的文件 */
  envChanged: string[]
  /** 计划进度（内核现算的，免得前端再数一遍） */
  progress: { done: number; total: number; current: number }
  canResume: boolean
}

/* ── 台账的桥（主进程 <-> 渲染层）──
 *
 * 从 safety.ts 搬来的：那边 308 行贴顶了，而这些都是**任务台账**的事。
 * 注意 `taskRemove` / `taskRemoveMany` 的 `skipped` —— 正在跑 / 等确认的任务
 * 永远删不掉（界面不给按钮，内核也会拦），那个数字就是「想删但没删」的条数。
 */
export interface TaskBridge {
  taskList: (options?: {
    limit?: number
    status?: string
    sessionId?: string
    workdir?: string
  }) => Promise<{
    ok: boolean
    tasks: TaskRecord[]
  }>
  taskUnfinished: () => Promise<{ ok: boolean; tasks: TaskRecord[] }>
  /** AG-012：重启后的恢复清单（带「停在哪一步 / 哪些文件被动过 / 恢复过几次」） */
  taskRecovery: (options?: {
    workdir?: string
  }) => Promise<{ ok: boolean; items: TaskRecoveryItem[] }>
  taskGet: (id: string) => Promise<{ ok: boolean; task: TaskRecord | null }>
  /** AG-035：把台账读成一段人能读的报告（只读，不改任务） */
  taskDiagnose: (id: string) => Promise<{ ok: boolean; diagnosis: TaskDiagnosis }>
  taskUpdate: (payload: { id: string; patch: Record<string, unknown> }) => Promise<{
    ok: boolean
    task?: TaskRecord
    error?: string
  }>
  taskRemove: (
    id: string,
  ) => Promise<{ ok: boolean; removed: number; skipped: number; reason?: string }>
  /** 按状态批量删；running / waiting_user 会被内核忽略并在 skipped 里报回来 */
  taskRemoveMany: (options: {
    statuses: string[]
    sessionId?: string
  }) => Promise<{ ok: boolean; removed: number; skipped: number }>
  /** 删掉一条对话的全部任务历史（删对话时一起清） */
  taskPurge: (sessionId: string) => Promise<{ ok: boolean; removed: number }>
  taskPauseRunning: () => Promise<{ ok: boolean; paused?: number }>
}
