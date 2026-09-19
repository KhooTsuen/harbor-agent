import { useState } from 'react'
import { ChevronDown, ChevronRight, History, Stethoscope } from 'lucide-react'
import type { AgentPhase } from '@/types'
import type { TaskRecord, TaskRecoveryItem } from '@/types/safety'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { BudgetEditor } from './BudgetEditor'
import { PlanCard } from './PlanCard'
import { ProgressTimeline } from './ProgressTimeline'
import { colorOf, iconOf, statusOfTask } from '@/lib/statusLanguage'
import { taskDiagnose } from '@/lib/safetyApi'
import type { TaskDiagnosis } from '@/types/safety'
import {
  currentStepOf,
  elapsedMs,
  formatDuration,
  formatUpdated,
  taskProgress,
} from './taskCenterModel'

/* ══════════════════════════════════════════════════════════════
   任务中心的一行（AG-028）

   动作从对话顶部的横幅搬过来的：继续 / 放弃 + 详情（计划版本 / 时间线 /
   环境变化警告 / 结果与错误）。横幅已经不显示了 —— 任务的东西只在
   一个地方出现，不会「打开应用先看到一条黄条却不知道该干什么」。
   ══════════════════════════════════════════════════════════════ */

/* AG-031：颜色与图标来自状态语言表，这里不再自己定色 */

/** 能接着做（和内核 task-resume.cjs 的 RESUMABLE 一致） */
const RESUMABLE: TaskRecord['status'][] = ['paused', 'waiting_user']
/** 能放弃（已经结束的就没必要再放弃一次） */
const CLOSABLE: TaskRecord['status'][] = ['running', 'paused', 'waiting_user', 'failed']

export function TaskRow({
  task,
  recovery,
  phases,
  now,
  active,
  busy,
  onOpen,
  onResume,
  onGiveUp,
}: {
  task: TaskRecord
  /** 恢复清单里对应的那条 —— 带 envChanged（停手后文件被谁动过） */
  recovery?: TaskRecoveryItem
  phases: AgentPhase[]
  now: number
  active: boolean
  busy: boolean
  onOpen: () => void
  onResume: () => void
  onGiveUp: () => void
}) {
  const [open, setOpen] = useState(false)
  /*
   * AG-035 诊断：按需拉。
   * 台账摊开是几百行，读成人话要花一点力气 —— 用户点了「诊断」才值当，
   * 而且**纯读**（不改任务、不跑东西），所以放在这里直接调桥就够了。
   */
  const [diagnosis, setDiagnosis] = useState<TaskDiagnosis | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  /* AG-040：撞了执行预算 → 停下等人，行内给 [继续][停止][调整预算] */
  const [editingBudget, setEditingBudget] = useState(false)
  const budgetHit = task.pauseReason === 'budget' ? (task.budgetHit ?? null) : null
  /* AG-041：转圈停下来 → 也说一句，并给「继续 / 停止」（没有「调整预算」这一项） */
  const loopHit = task.pauseReason === 'loop' ? (task.loopHit ?? null) : null
  const uiStatus = statusOfTask(task.status)
  const statusColor = colorOf(uiStatus)
  const Icon = iconOf(uiStatus)
  const progress = taskProgress(task)
  const envChanged = recovery?.envChanged ?? []
  const changed = task.changedFiles.length

  /** 拉一次诊断；再点一次收起来（报告已经在手上就不必再问一遍） */
  async function runDiagnose(): Promise<void> {
    if (diagnosis) {
      setDiagnosis(null)
      return
    }
    setDiagnosing(true)
    try {
      setDiagnosis(await taskDiagnose(task.id))
    } finally {
      setDiagnosing(false)
    }
  }

  async function copyDiagnosis(): Promise<void> {
    if (!diagnosis?.text) return
    try {
      await navigator.clipboard.writeText(diagnosis.text)
    } catch {
      /* 复制不了就算了 —— 报告就在眼前，用户可以自己选中 */
    }
  }

  return (
    <div
      className={cn(
        'rounded-sm border border-line-hairline bg-bg-raised/40',
        active && 'bg-bg-raised',
      )}
      style={active ? { borderColor: 'var(--accent-blue)' } : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`任务：${task.title || task.goal || '未命名'}`}
        className="flex w-full items-start gap-1.5 px-2.5 py-2 text-left transition-colors duration-fast hover:bg-bg-hover"
      >
        <Icon size={13} className="mt-0.5 shrink-0" style={{ color: statusColor }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg-primary">
            {task.title || task.goal || '(没有标题的任务)'}
          </span>
          {/* 当前步骤 / 下一步 —— 这一行才是重点，元信息都压到下面那一行 */}
          <span className="mt-0.5 block truncate text-2xs text-fg-secondary">
            {currentStepOf(task)}
          </span>
          {/*
            AG-030：默认只留「进度 + 结果」两件。
            原来这里挤了六项（步数 · Tool · 改文件 · 恢复次数 · 历时 · 更新），
            文档要求重点突出「当前任务 / 当前步骤 / 结果 / 异常 / 下一步」——
            其余都是可以展开再看的细节。零值也不显示（「改了 0 个文件」是噪音）。
          */}
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-fg-tertiary">
            <span>
              {progress.done}/{progress.total} 步
            </span>
            {changed > 0 ? <span>改了 {changed} 个文件</span> : null}
            {task.errors.length > 0 ? (
              <span style={{ color: colorOf('failed') }}>{task.errors.length} 次失败</span>
            ) : null}
            {budgetHit ? (
              <span style={{ color: colorOf('warning') }}>
                已达到{budgetHit.label}（{budgetHit.used} / {budgetHit.limit}）
              </span>
            ) : null}
            {loopHit ? (
              <span style={{ color: colorOf('warning') }} title={loopHit.samples?.join(' → ')}>
                检测到重复执行（{loopHit.count} 次同类调用）
              </span>
            ) : null}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-2xs text-fg-tertiary transition-colors duration-fast hover:text-fg-secondary"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 详情
        </button>
        <span className="flex-1" />
        {RESUMABLE.includes(task.status) ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<History size={12} />}
            loading={busy}
            onClick={onResume}
          >
            继续
          </Button>
        ) : null}
        {budgetHit ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setEditingBudget((value) => !value)}
          >
            调整预算
          </Button>
        ) : null}
        {CLOSABLE.includes(task.status) ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onGiveUp}>
            {budgetHit || loopHit ? '停止' : '放弃'}
          </Button>
        ) : null}
      </div>

      {editingBudget ? (
        <div className="px-2">
          <BudgetEditor task={task} onDone={() => setEditingBudget(false)} />
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-line-hairline px-2 py-2">
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
              onClick={() => void runDiagnose()}
              className="flex items-center gap-1 rounded-sm px-1 text-2xs transition-colors duration-fast hover:bg-bg-hover hover:text-fg-secondary disabled:opacity-50"
            >
              <Stethoscope size={11} />
              {diagnosing ? '诊断中…' : diagnosis ? '收起诊断' : '诊断'}
            </button>
          </p>

          {diagnosis ? (
            <div className="mb-1.5 rounded-sm border border-line-subtle bg-bg-base/40">
              <p className="px-2 py-1 text-2xs text-fg-secondary">{diagnosis.conclusion}</p>
              <div className="flex items-center gap-2 border-t border-line-subtle px-2 py-1 text-2xs text-fg-tertiary">
                <span className="flex-1">
                  模型 {task.model || '没有记录'} · 授权 {task.permissions?.length ?? 0} 条 · 检查点{' '}
                  {task.checkpoints.length} 个
                </span>
                <button
                  type="button"
                  onClick={() => void copyDiagnosis()}
                  className="shrink-0 rounded-sm px-1 hover:bg-bg-hover hover:text-fg-primary"
                >
                  复制全文
                </button>
              </div>
              <pre className="max-h-64 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] whitespace-pre-wrap text-fg-tertiary">
                {diagnosis.text}
              </pre>
            </div>
          ) : null}
          {envChanged.length > 0 ? (
            <p className="mb-1.5 text-2xs" style={{ color: colorOf('warning') }}>
              ⚠ 你离开之后 {envChanged.length} 个文件被改过（
              {envChanged
                .slice(0, 2)
                .map((f) => f.split(/[\\/]/).pop())
                .join('、')}
              ）—— 接着做之前它会先重读
            </p>
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
      ) : null}
    </div>
  )
}
