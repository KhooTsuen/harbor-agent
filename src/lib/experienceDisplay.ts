import type { ExperienceItem, ExperienceStatus } from '@/types/experience'

/* ══════════════════════════════════════════════════════════════
   经验页的**显示口径**（文案 / 语义色 / 一行摘要）

   为什么单独一个文件：`ExperienceTab.tsx` 已经 260+ 行、贴 300 红线，
   而这里全是「同一个状态怎么称呼、用什么颜色、一行里说哪几句」——
   下一次加筛选维度（类别 / 领域）也该长在这里，不该把组件继续撑大。

   ★ 这里**没有任何判据**：能不能注入、能不能批准都由主进程算好
     （`injectable` / `pending` / `blockedReason`）。这里只做显示。
   ══════════════════════════════════════════════════════════════ */

export const STATUS_LABEL: Record<ExperienceStatus, string> = {
  candidate: '待处理',
  verified: '生效中',
  suspended: '已停止',
  rejected: '已驳回',
  deprecated: '已废弃',
}

export const STATUS_COLOR: Record<
  ExperienceStatus,
  'waiting' | 'completed' | 'warning' | 'failed' | 'neutral'
> = {
  candidate: 'waiting',
  verified: 'completed',
  suspended: 'warning',
  rejected: 'neutral',
  deprecated: 'neutral',
}

export type Filter = 'pending' | 'verified' | 'suspended' | 'all'

export const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'verified', label: '生效中' },
  { id: 'suspended', label: '已停止' },
  { id: 'all', label: '全部' },
]

/** 一条经验在一行里要说清的事（多一条都嫌长 —— 这一页每行都很挤） */
export function metaOf(item: ExperienceItem): string[] {
  const bits = [STATUS_LABEL[item.status] ?? item.status, item.domain || 'other']
  if (item.reasonCode) bits.push(item.reasonCode)
  if (item.reproductions > 1) bits.push(`复现 ${item.reproductions} 次`)
  const ok = item.verifications?.length ?? 0
  if (ok > 0) bits.push(`验证 ${ok} 次`)
  const bad = item.contradictions?.length ?? 0
  if (bad > 0) bits.push(`反例 ${bad} 次`)
  if (item.approval?.by === 'user') bits.push('人工批准')
  return bits
}

/**
 * 这一行现在是不是要显示输入框（写新做法 / 改已有做法）。
 *
 * 口径（**不是判据**，只影响「输入框画不画」）：
 *   · 没有做法、还没被驳回 → 批准前必须先写一句；
 *   · 人点开了「改做法」→ 无论有没有做法都给输入框。
 */
export function needsDraftInput(item: ExperienceItem, editing: boolean): boolean {
  if (item.status === 'rejected' || item.status === 'deprecated') return false
  if (editing) return true
  return item.status !== 'verified' && !item.recommendedAction
}
