import type { ExperienceAction, ExperienceItem, ExperienceStats } from '@/types/experience'

/* ══════════════════════════════════════════════════════════════
   经验（自我纠错闭环）的桥包装

   与别的 API 一样：失败不抛异常、返回空值；浏览器预览里没有桥，
   界面那边显示「需要桌面版」。

   ★ 这里**不做任何判据**：能不能注入、能不能批准，都由主进程算好
     （`injectable` / `pending` / `blockedReason`）。前端再算一遍必然漂。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

export function experienceSupported(): boolean {
  return Boolean(bridge?.experienceList)
}

export async function experienceList(options?: {
  status?: string
  includeClosed?: boolean
}): Promise<{ items: ExperienceItem[]; stats: ExperienceStats }> {
  const empty: ExperienceStats = { total: 0, byStatus: {}, verified: 0 }
  if (!bridge?.experienceList) return { items: [], stats: empty }
  try {
    const result = await bridge.experienceList(options)
    return { items: result.items ?? [], stats: result.stats ?? empty }
  } catch {
    return { items: [], stats: empty }
  }
}

export async function experienceStats(): Promise<ExperienceStats> {
  const empty: ExperienceStats = { total: 0, byStatus: {}, verified: 0 }
  if (!bridge?.experienceStats) return empty
  try {
    const result = await bridge.experienceStats()
    return result.stats ?? empty
  } catch {
    return empty
  }
}

/**
 * 人做一次决定。
 *
 * 失败原因原样带回去（`reason`）：界面要说清「为什么不让我批」——
 * `needs_action` = 没有可注入的做法，得先填一句；`blocked` = 状态不允许。
 */
export async function experienceReview(payload: {
  id: string
  action: ExperienceAction
  actionText?: string
  note?: string
}): Promise<{ ok: boolean; item?: ExperienceItem; error?: string; reason?: string }> {
  if (!bridge?.experienceReview) return { ok: false, error: '需要桌面版', reason: 'no_bridge' }
  try {
    const result = await bridge.experienceReview(payload)
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
