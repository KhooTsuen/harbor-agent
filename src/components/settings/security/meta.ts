import type { RiskVerdict } from '@/types/backend'
import { colorOf } from '@/lib/statusLanguage'

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

/*
 * 完整说法。单独一张表是必要的：`LEVEL_LABEL.critical` 是「危险」，
 * 调用处再拼一个「风险」就成了「危险风险」（真机上确实这么显示过）。
 */
export const LEVEL_FULL_LABEL: Record<RiskVerdict['level'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '危险',
}

export const LEVEL_COLOR: Record<RiskVerdict['level'], string> = {
  low: colorOf('completed'),
  medium: colorOf('warning'),
  high: colorOf('failed'),
  critical: colorOf('failed'),
}
