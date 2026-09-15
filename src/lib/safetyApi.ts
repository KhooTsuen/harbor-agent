import type {
  AuditEntry,
  AuditStats,
  CapabilityGrant,
  ChangeSetSummary,
  CredentialsStatus,
  RiskVerdict,
  TaskRecord,
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

export async function taskList(options?: {
  limit?: number
  status?: string
}): Promise<TaskRecord[]> {
  if (!bridge?.taskList) return []
  try {
    const result = await bridge.taskList(options)
    return result.tasks ?? []
  } catch {
    return []
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
