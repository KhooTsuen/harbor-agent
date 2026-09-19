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
