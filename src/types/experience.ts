/* 经验（自我纠错闭环）的类型 —— 形状来自 electron/core/experience-schema.cjs

   为什么单独一个文件：`types/backend.ts` 已经 280+ 行、贴 300 红线，
   而这一块有状态机 / 审批 / 验证三组字段。挂进 `WorkbenchBridge` 的方式
   与 `types/errors.ts` 一致：那边写 interface，backend.ts 里 extends 回来。

   ★ 判据字段（能不能注入）**主进程算好送过来**（`injectable` / `pending` /
     `blockedReason`），前端不重算 —— 「人批的不看验证器版本」那条口径在
     experience-schema.cjs 的 `injectable()` 里，两边各写一份必然漂。
*/

/** 状态：只有 verified 会进提示（见 experience-schema.INJECTABLE） */
export type ExperienceStatus = 'candidate' | 'verified' | 'suspended' | 'rejected' | 'deprecated'

/** 一次验证（谁核的、哪次执行、在哪个项目） */
export interface ExperienceVerification {
  opportunityId: string
  at: number
  evidence: string
  projectId: string
  sessionId: string
  /** 验证器 id@版本，例如 `shell_exit_zero@1`；空串 = 旧记录 */
  verifier: string
  /** 这一次就是「首次认下这条修法」那一次 */
  adopted?: boolean
}

/** 一次反例（同类操作在生效之后又失败） */
export interface ExperienceContradiction {
  opportunityId: string
  at: number
  evidence: string
  projectId: string
  sessionId: string
}

/** 人的批准（有它就不看验证器版本，判据在 schema.injectable） */
export interface ExperienceApproval {
  by: 'user'
  at: number
  action: 'approve' | 'restore'
  note: string
  /**
   * **批准那一刻**认定的「该怎么做」—— 历史值，不随后续修订变。
   * 当前真正注入的是 `ExperienceItem.recommendedAction`（可能已被人工改过，见 `amend`）。
   */
  actionText: string
  validatorVersion: number
}

/** 一条经验（设置页要显示的全部字段） */
export interface ExperienceItem {
  id: string
  status: ExperienceStatus
  scope: 'global' | 'project' | 'session'
  projectId: string
  sessionId: string
  tool: string
  domain: string
  category: string
  reasonCode: string
  /** 「同一个目标」（验证 / 反例都要求它一致） */
  target: string
  triggerText: string
  causeHypothesis: string
  /** 注入时说的「上次这样做成功了」 */
  recommendedAction: string
  risk: 'low' | 'high'
  reproductions: number
  verifications: ExperienceVerification[]
  contradictions: ExperienceContradiction[]
  injectedCount: number
  lastInjectedAt: number
  createdAt: number
  updatedAt: number
  lastSeenAt: number
  history: Array<{ at: number; from: string; to: string; why: string }>
  recipe?: { key: string; evidence: string; adoptedAt: number }
  approval?: ExperienceApproval | null
  /* ── 以下三个由主进程算好（见 experience-store.listForReview）── */
  /** 现在能不能进提示 */
  injectable: boolean
  /** 还能被人动（candidate / suspended） */
  pending: boolean
  /** 不能批准的原因（空串 = 可以） */
  blockedReason: string
}

export interface ExperienceStats {
  total: number
  byStatus: Partial<Record<ExperienceStatus, number>>
  verified: number
}

/**
 * 审批动作：
 *   · `approve`  candidate → verified
 *   · `restore`  suspended → verified（恢复不清零反例）
 *   · `reject`   → rejected（终点）
 *   · `amend`    **不碰状态**，只改「注入时说的那句话」
 */
export type ExperienceAction = 'approve' | 'reject' | 'restore' | 'amend'

/** 挂在 `window.workbench` 上的那几个方法（backend.ts 通过 extends 合回去） */
export interface ExperienceBridge {
  experienceList: (options?: {
    status?: string
    includeClosed?: boolean
  }) => Promise<{ ok: boolean; items: ExperienceItem[]; stats: ExperienceStats }>
  experienceStats: () => Promise<{ ok: boolean; stats: ExperienceStats }>
  /**
   * 人做一次决定。失败时 `reason` 是机器可读的原因：
   * `needs_action`（没有可注入的做法）/ `blocked`（状态不允许）/ `no_such_item`。
   */
  experienceReview: (payload: {
    id: string
    action: ExperienceAction
    /** 批准时手写的「该怎么做」（可空：系统记过就用系统的） */
    actionText?: string
    /** 留痕用的备注（不进提示） */
    note?: string
  }) => Promise<{
    ok: boolean
    item?: ExperienceItem
    error?: string
    reason?: string
    stats: ExperienceStats
  }>
}
