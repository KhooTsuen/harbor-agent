import type { ReactElement } from 'react'
import type { TaskRecord } from '@/types/task'
import type { TaskDiagnosis } from '@/types/safety'
import { labelOf, statusOfTask } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   任务行里那两块「说人话」的小东西

   从 TaskRow 抽出来的（那边贴到 300 行上限了）：都是纯展示逻辑，
   不碰状态、不发请求，所以单独放一层反而好测。
   ══════════════════════════════════════════════════════════════ */

/** 收起时那一行状态摘要：「已暂停 · 达到轮数上限」这种 */
export function rowStatusSummary(
  status: TaskRecord['status'],
  hits: { budgetLabel?: string; loop?: boolean; interrupted?: boolean } = {},
): string {
  const label = labelOf(statusOfTask(status))
  if (hits.budgetLabel) return `${label} · 达到${hits.budgetLabel}`
  if (hits.loop) return `${label} · 检测到重复执行`
  /* 上次是被强杀/崩溃退出的 —— 不说的话用户以为任务是自己停的 */
  if (hits.interrupted) return `${label} · 上次被中断`
  return label
}

/** 下面那行步骤的前缀：停下来了叫「下一步」，在跑叫「正在做」 */
export function rowStepPrefix(status: TaskRecord['status']): string {
  if (status === 'paused' || status === 'waiting_user') return '下一步：'
  if (status === 'running') return '正在做：'
  return ''
}

/** AG-035 诊断面板（纯展示，复制行为由外面给） */
export function TaskDiagnosisPanel({
  diagnosis,
  task,
  onCopy,
}: {
  diagnosis: TaskDiagnosis
  task: TaskRecord
  onCopy: () => void
}): ReactElement {
  return (
    <div className="mb-1.5 rounded-sm border border-line-subtle bg-bg-base/40">
      <p className="px-2 py-1 text-2xs text-fg-secondary">{diagnosis.conclusion}</p>
      <div className="flex items-center gap-2 border-t border-line-subtle px-2 py-1 text-2xs text-fg-tertiary">
        <span className="flex-1">
          模型 {task.model || '没有记录'} · 授权 {task.permissions?.length ?? 0} 条 · 检查点{' '}
          {task.checkpoints.length} 个
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-sm px-1 hover:bg-bg-hover hover:text-fg-primary"
        >
          复制全文
        </button>
      </div>
      <pre className="max-h-64 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] whitespace-pre-wrap text-fg-tertiary">
        {diagnosis.text}
      </pre>
    </div>
  )
}
