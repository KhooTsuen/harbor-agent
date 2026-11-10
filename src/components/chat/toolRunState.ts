import type { ToolRunRecord } from '@/types'

export type ToolRunState = 'running' | 'unconfirmed' | 'completed' | 'failed'

/** 没有终态时，只有当前执行仍活跃才能称为“进行中”。 */
export function stateOfRun(run: ToolRunRecord, live: boolean): ToolRunState {
  const waiting = run.pending === true || (run.output === '' && run.ms === undefined)
  if (waiting) return live ? 'running' : 'unconfirmed'
  return run.ok ? 'completed' : 'failed'
}

export const toolStateLabels: Record<ToolRunState, string> = {
  running: '进行中',
  unconfirmed: '结果未确认',
  completed: '成功',
  failed: '失败',
}
