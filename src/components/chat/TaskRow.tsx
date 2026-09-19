import { useState } from 'react'
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  History,
  PauseCircle,
  XCircle,
} from 'lucide-react'
import type { AgentPhase } from '@/types'
import type { TaskRecord, TaskRecoveryItem } from '@/types/safety'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { PlanCard } from './PlanCard'
import { ProgressTimeline } from './ProgressTimeline'
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

const STATUS_STYLE: Record<TaskRecord['status'], { color: string; icon: typeof CircleDot }> = {
  running: { color: 'var(--accent-blue)', icon: CircleDot },
  paused: { color: 'var(--warning)', icon: PauseCircle },
  waiting_user: { color: 'var(--warning)', icon: Clock3 },
  completed: { color: 'var(--success)', icon: CheckCircle2 },
  failed: { color: 'var(--danger)', icon: XCircle },
  cancelled: { color: 'var(--fg-tertiary)', icon: Ban },
}

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
  const style = STATUS_STYLE[task.status]
  const Icon = style.icon
  const progress = taskProgress(task)
  const envChanged = recovery?.envChanged ?? []
  const changed = task.changedFiles.length

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
        <Icon size={13} className="mt-0.5 shrink-0" style={{ color: style.color }} />
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
              <span style={{ color: 'var(--danger)' }}>{task.errors.length} 次失败</span>
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
        {CLOSABLE.includes(task.status) ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onGiveUp}>
            放弃
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-line-hairline px-2 py-2">
          {/* 运行细节：默认折叠，展开才看（AG-030：不默认刷屏）*/}
          <p className="mb-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-fg-tertiary">
            <span>{task.steps.length} Tool</span>
            <span>历时 {formatDuration(elapsedMs(task, now))}</span>
            <span>更新 {formatUpdated(task.updatedAt)}</span>
            {task.resumeCount ? <span>恢复过 {task.resumeCount} 次</span> : null}
          </p>
          {envChanged.length > 0 ? (
            <p className="mb-1.5 text-2xs" style={{ color: 'var(--warning)' }}>
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
                <li key={error.at} className="text-2xs" style={{ color: 'var(--danger)' }}>
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
