import type { RiskVerdict } from '@/types/backend'

/* 安全页共用的小常量 —— 拆出来是因为主组件已经很长了 */

export const SCOPE_OPTIONS = [
  { value: 'workspace', label: '仅工作目录（推荐）', hint: '出去要你批准' },
  { value: 'granted', label: '工作目录 + 已授权路径', hint: '批准过的目录直接可用' },
  { value: 'full', label: '不限制', hint: '⚠️ Agent 可读写任何位置' },
]

export const POLICY_OPTIONS = [
  { value: 'allow', label: '直接执行' },
  { value: 'ask', label: '先问我' },
  { value: 'block', label: '拦下' },
]

export const LEVEL_LABEL: Record<RiskVerdict['level'], string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '危险',
}

export const LEVEL_COLOR: Record<RiskVerdict['level'], string> = {
  low: 'var(--success)',
  medium: 'var(--warning)',
  high: 'var(--danger)',
  critical: 'var(--danger)',
}
