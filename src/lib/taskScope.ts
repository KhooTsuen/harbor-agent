/**
 * 任务中心的「看哪些任务」
 *
 * 任务本身带 `workdir`（谁在哪个项目里跑的），过滤在主进程按它做。
 * 这里只回答一件事：**这次刷新要不要带项目目录**。
 *
 * 为什么要有这一层：默认只看当前项目（跟已上线行为一致），但用户可能想一眼看到
 * 所有项目里跑过什么 —— 所以给它一个开关，而不是直接过滤掉。抽成纯函数是为了能测。
 */

export type TaskScope = 'project' | 'all'

/** 要传给主进程的 workdir：'' = 不过滤（看全部） */
export function scopeWorkdirOf(scope: TaskScope, projectWorkdir: string): string {
  if (scope === 'all') return ''
  return projectWorkdir || ''
}

/** 标题旁边那句说明 */
export function scopeLabelOf(scope: TaskScope, contextName: string): string {
  return scope === 'all' ? '全部项目' : contextName || '当前对话'
}

/** 开关按钮上的文案（点一下会切到另一边） */
export function scopeToggleLabelOf(scope: TaskScope): string {
  return scope === 'all' ? '只看当前项目' : '看全部项目'
}
