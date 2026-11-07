import type { MemoryItem } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   记忆的显示标签（类型 / 来源 / 归属 / 启用措辞）

   从 `MemoryTab.tsx` 抽出来的（那边 298 行贴顶，第二阶段要重排层级
   就得先腾地方）。这些是**纯展示映射**，不碰任何状态 —— 抽出来后
   列表组件和页面本身读同一份，不会出现「列表显示偏好、详情显示 fact」。
   ══════════════════════════════════════════════════════════════ */

export const TYPE_LABEL: Record<MemoryItem['type'], string> = {
  preference: '偏好',
  fact: '事实',
  workflow: '流程',
  project_rule: '项目规则',
  constraint: '约束',
  decision: '已定方案',
  temporary: '临时',
  habit: '习惯',
  instruction: '要求',
}

export const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  user_explicit: '你说的',
  user_confirmed: '你确认的',
  model_suggested: '模型建议',
  imported: '旧版本导入',
  system: '系统',
}

export const SCOPE_LABEL: Record<MemoryItem['scope'], string> = {
  global: '全局',
  project: '项目',
  workspace: '工作目录',
  task: '任务',
  session: '本次会话',
}

/* 「过期」不是用户关掉的，是它自己到期的 —— 措辞给「恢复」。
   `enable()` 走 `update({status:'active'})`，会连 `expiresAt` 一起清掉（memory-store.cjs）。 */
export function enableLabel(status: MemoryItem['status']): string {
  return status === 'expired' ? '恢复' : '启用'
}
