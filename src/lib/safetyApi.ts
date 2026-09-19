import type {
  ChangeSetDiff,
  PerfTimeline,
  TaskDiagnosis,
  AuditEntry,
  AuditStats,
  CapabilityGrant,
  ChangeSetSummary,
  CredentialsStatus,
  RiskVerdict,
  TaskRecord,
  TaskRecoveryItem,
  WorkbenchBridge,
} from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   安全 / 可靠的桥包装

   审计、路径授权、任务、改动事务、凭证状态。
   浏览器预览没有这些（没有桥），全部返回空结果而不是抛异常 ——
   设置页在这些面板上要能正常显示「桌面版才有」。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

const EMPTY_STATS: AuditStats = { days: 0, total: 0, failed: 0, denied: 0, byTool: {} }

export async function auditList(options?: {
  day?: string
  limit?: number
  sessionId?: string
  onlyProblems?: boolean
}): Promise<{ entries: AuditEntry[]; days: string[] }> {
  if (!bridge?.auditList) return { entries: [], days: [] }
  try {
    const result = await bridge.auditList(options)
    return { entries: result.entries ?? [], days: result.days ?? [] }
  } catch {
    return { entries: [], days: [] }
  }
}

export async function auditStats(days = 7): Promise<AuditStats> {
  if (!bridge?.auditStats) return EMPTY_STATS
  try {
    const result = await bridge.auditStats(days)
    return result.stats ?? EMPTY_STATS
  } catch {
    return EMPTY_STATS
  }
}

export async function auditClear(): Promise<{ ok: boolean; removed: number }> {
  if (!bridge?.auditClear) return { ok: false, removed: 0 }
  try {
    return await bridge.auditClear()
  } catch {
    return { ok: false, removed: 0 }
  }
}

/** 试算一条命令的风险等级（设置页里给用户看的） */
export async function classifyCommand(
  command: string,
): Promise<{ verdict: RiskVerdict; action: string } | null> {
  if (!bridge?.riskClassify) return null
  try {
    const result = await bridge.riskClassify(command)
    return result.ok ? { verdict: result.verdict, action: result.decide.action } : null
  } catch {
    return null
  }
}

export async function capabilityList(): Promise<CapabilityGrant[]> {
  if (!bridge?.capabilityList) return []
  try {
    const result = await bridge.capabilityList()
    return result.grants ?? []
  } catch {
    return []
  }
}

export async function capabilityRevoke(target: string): Promise<void> {
  if (!bridge?.capabilityRevoke) return
  try {
    await bridge.capabilityRevoke(target)
  } catch {
    /* 忽略 */
  }
}

export async function capabilityRevokeAll(): Promise<void> {
  if (!bridge?.capabilityRevokeAll) return
  try {
    await bridge.capabilityRevokeAll()
  } catch {
    /* 忽略 */
  }
}

export async function taskUnfinished(): Promise<TaskRecord[]> {
  if (!bridge?.taskUnfinished) return []
  try {
    const result = await bridge.taskUnfinished()
    return result.tasks ?? []
  } catch {
    return []
  }
}

/**
 * AG-012：重启后的恢复清单。
 * 比 taskUnfinished 多带「停在哪一步 / 哪些文件被动过 / 恢复过几次」——
 * 都是用户决定「要不要接着做」时该知道的事。
 */
export async function taskRecovery(): Promise<TaskRecoveryItem[]> {
  if (!bridge?.taskRecovery) return []
  try {
    const result = await bridge.taskRecovery()
    return result.items ?? []
  } catch {
    return []
  }
}

export async function taskList(options?: {
  limit?: number
  status?: string
  /* 主进程的 task:list 一直支持按会话过滤，前端类型漏了 —— AG-011 用上才发现 */
  sessionId?: string
}): Promise<TaskRecord[]> {
  if (!bridge?.taskList) return []
  try {
    const result = await bridge.taskList(options)
    return result.tasks ?? []
  } catch {
    return []
  }
}

/** AG-037：最近几次的性能时间线（拿不到就给空数组，面板显示「还没有数据」） */
export async function metricsRecent(limit = 5): Promise<PerfTimeline[]> {
  if (!bridge?.metricsRecent) return []
  try {
    const result = await bridge.metricsRecent({ limit })
    return result.items ?? []
  } catch {
    return []
  }
}

/** AG-035：诊断报告（读不出来时给一份空壳，界面显示「这个桌面版才有」） */
/** AG-036：最近一批改动的 diff（取不到就给空壳，界面显示「还没有改动」） */
export async function changesetDiff(sessionId = ''): Promise<ChangeSetDiff> {
  const empty: ChangeSetDiff = {
    id: '',
    title: '',
    taskId: '',
    sessionId: '',
    status: '',
    at: 0,
    files: [],
    additions: 0,
    deletions: 0,
    skipped: [],
  }
  if (!bridge?.changesetDiff) return empty
  try {
    const result = await bridge.changesetDiff({ sessionId })
    return result.diff ?? empty
  } catch {
    return empty
  }
}

export async function taskDiagnose(id: string): Promise<TaskDiagnosis> {
  const empty: TaskDiagnosis = { title: '', status: '', conclusion: '', text: '' }
  if (!bridge?.taskDiagnose) return empty
  try {
    const result = await bridge.taskDiagnose(id)
    return result.diagnosis ?? empty
  } catch {
    return empty
  }
}

export async function taskUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!bridge?.taskUpdate) return
  try {
    await bridge.taskUpdate({ id, patch })
  } catch {
    /* 忽略 */
  }
}

export async function taskRemove(id: string): Promise<void> {
  if (!bridge?.taskRemove) return
  try {
    await bridge.taskRemove(id)
  } catch {
    /* 忽略 */
  }
}

export async function changesetList(options?: { limit?: number }): Promise<ChangeSetSummary[]> {
  if (!bridge?.changesetList) return []
  try {
    const result = await bridge.changesetList(options)
    return result.changesets ?? []
  } catch {
    return []
  }
}

export async function changesetRollback(id: string): Promise<{
  ok: boolean
  restored: string[]
  removed: string[]
  failed: Array<{ path: string; reason: string }>
}> {
  if (!bridge?.changesetRollback) {
    return { ok: false, restored: [], removed: [], failed: [] }
  }
  try {
    const result = await bridge.changesetRollback(id)
    return {
      ok: result.ok === true,
      restored: result.restored ?? [],
      removed: result.removed ?? [],
      failed: result.failed ?? [],
    }
  } catch {
    return { ok: false, restored: [], removed: [], failed: [] }
  }
}

export async function credentialsStatus(): Promise<CredentialsStatus | null> {
  if (!bridge?.credentialsStatus) return null
  try {
    const result = await bridge.credentialsStatus()
    return result.status ?? null
  } catch {
    return null
  }
}
