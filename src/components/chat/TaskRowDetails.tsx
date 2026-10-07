import { Stethoscope } from 'lucide-react'
import type { AgentPhase } from '@/types'
import type { TaskDiagnosis, TaskRecord } from '@/types/safety'
import { colorOf } from '@/lib/statusLanguage'
import { TaskConsole } from './TaskConsole'
import { PlanCard } from './PlanCard'
import { ProgressTimeline } from './ProgressTimeline'
import { TaskDiagnosisPanel } from './TaskRowParts'
import { elapsedMs, formatDuration, formatUpdated } from './taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   任务中心：一行的「详情」面板（从 TaskRow.tsx 拆出来的）

   折叠着的那一块：控制台 + 运行细节 + 诊断 + 环境变化 + 改过方向 + 计划/时间线/结果。
   从主文件分出来的理由是它「只是展示」—— 数据与回调都由 props 给，
   所以这一块永远不会反过来影响 TaskRow 的状态机。
   ══════════════════════════════════════════════════════════════ */

export function TaskRowDetails({
  task,
  now,
  phases,
  envChanged,
  diagnosis,
  diagnosing,
  onDiagnose,
  onCopy,
}: {
  task: TaskRecord
  now: number
  phases: AgentPhase[]
  /** 任务停下来后文件被谁动过（任务级检查，不是「你离开之后」） */
  envChanged: string[]
  diagnosis: TaskDiagnosis | null
  diagnosing: boolean
  onDiagnose: () => void
  onCopy: () => void
}) {
  return (
    <div className="border-t border-line-hairline px-2 py-2">
      {/* AG-042：控制台（八项状态 + 六个动作）—— 放进详情，默认折叠 */}
      <TaskConsole task={task} now={now} />

      {/* 运行细节：默认折叠，展开才看（AG-030：不默认刷屏）*/}
      <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-tertiary">
        <span>{task.steps.length} Tool</span>
        <span>历时 {formatDuration(elapsedMs(task, now))}</span>
        <span>更新 {formatUpdated(task.updatedAt)}</span>
        {task.resumeCount ? <span>恢复过 {task.resumeCount} 次</span> : null}
        {/* AG-035：这条任务到底怎么回事 —— 一句话结论 + 可按需展开全篇 */}
        <button
          type="button"
          disabled={diagnosing}
          onClick={() => void onDiagnose()}
          className="flex items-center gap-1 rounded-sm px-1 text-2xs transition-colors duration-fast hover:bg-bg-hover hover:text-fg-secondary disabled:opacity-50"
        >
          <Stethoscope size={11} />
          {diagnosing ? '诊断中…' : diagnosis ? '收起诊断' : '诊断'}
        </button>
      </p>

      {diagnosis ? (
        <TaskDiagnosisPanel diagnosis={diagnosis} task={task} onCopy={() => void onCopy()} />
      ) : null}
      {envChanged.length > 0 ? (
        /* 措辞（2026-10-03）：任务级检查（任务停下来后文件被谁动过），别说成「你离开之后」 */
        <p className="mb-1.5 text-2xs" style={{ color: colorOf('warning') }}>
          ⚠ 这个任务暂停之后 {envChanged.length} 个文件被改过（
          {envChanged
            .map((f) => f.split(/[\\/]/).pop())
            .slice(0, 2)
            .join('、')}
          ）—— 接着做之前它会先重读
        </p>
      ) : null}
      {/* AG-043：用户在执行中改过方向 —— 原话留在这里（复盘时最有用的就是这句） */}
      {(task.steering ?? []).length > 0 ? (
        <div className="mb-1.5">
          <h4 className="text-2xs text-fg-tertiary">你改过方向 · {task.steering?.length}</h4>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {(task.steering ?? []).slice(-3).map((item) => (
              <li key={item.at} className="text-2xs text-fg-secondary">
                · {item.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <PlanCard versions={task.planVersions ?? []} />
      <ProgressTimeline phases={phases} steps={task.steps} plan={task.plan} />
      {task.result ? (
        <p className="mt-2 whitespace-pre-wrap text-2xs text-fg-tertiary">{task.result}</p>
      ) : null}
      {task.errors.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {task.errors.slice(-3).map((error) => (
            <li key={error.at} className="text-2xs" style={{ color: colorOf('failed') }}>
              · {error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
