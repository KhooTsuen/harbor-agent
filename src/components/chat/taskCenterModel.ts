import type { TaskRecord } from '@/types/safety'
import { labelOf, statusOfTask } from '@/lib/statusLanguage'

/*
 * 分组顺序（进行中在最前）+ 组标题文字。
 * 文字取自 AG-031 的状态语言表 —— 全应用只有那一份，别在这儿再抄一遍。
 */
const GROUP_ORDER: readonly TaskRecord['status'][] = [
  'running',
  'paused',
  'waiting_user',
  'failed',
  'completed',
  'cancelled',
]

export const TASK_GROUPS: ReadonlyArray<{ status: TaskRecord['status']; label: string }> =
  GROUP_ORDER.map((status) => ({ status, label: labelOf(statusOfTask(status)) }))

/**
 * 计划行带 markdown 列表前缀（`- ` / `* `）是很常见的 —— 模型写计划时就是这么写的
 * （真机数据里 `- [x] 列出工作目录里的文件`）。这两个函数以前只认行首的 `[x]`，
 * 于是那种行**永远算未完成**，进度还是显示成「- [x] xxx」。
 */
export function isPlanDone(line: string): boolean {
  return /^\s*(?:[-*]\s+)?\[[xX]\]/.test(String(line))
}

export function cleanPlanLine(line: string): string {
  return String(line)
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\[[xX ]\]\s*/, '')
    .trim()
}

export function taskProgress(task: TaskRecord): { done: number; total: number } {
  const plan = task.plan ?? []
  return { done: plan.filter(isPlanDone).length, total: plan.length }
}

/**
 * 真实执行事实的汇总（Phase 5）。
 *
 * 为什么需要它：UI 上唯一带「N/M」形状的进度就是 `planProgressLabel`，它数的是
 * **模型在计划块里打的 `[x]`** —— 而模型只在每次发送的**第 1 个 LLM 轮次**输出正文
 * （计划块在里面），后续工具轮没有正文，内核再没看到过新计划块，于是那个数字
 * 永远停在 `0/M`（定位与实测见 `docs/research/ui-phase5-progress-design.md`）。
 *
 * 这里改用**内核记录的真实执行事实**（`steps` / `checkpoints` / `changedFiles`）——
 * 它们本来就在台账里，且前端每次工具跑完都会重读（`streamEvents` 的 AG-005）。
 * **零新字段、零猜测**：**不**建立「计划第 N 条 ↔ 哪个工具」的映射 ——
 * 内核里没有这个归属事实，按顺序硬配就是编（同 `ProgressTimeline` 的既定原则）。
 */
export interface ExecSummary {
  /** 内核记下的工具调用次数（含失败） */
  steps: number
  ok: number
  failed: number
  checkpoints: number
  files: number
}

export function execSummary(task: TaskRecord): ExecSummary {
  const steps = task.steps ?? []
  const failed = steps.filter((step) => step.ok === false).length
  return {
    steps: steps.length,
    ok: steps.length - failed,
    failed,
    checkpoints: (task.checkpoints ?? []).length,
    files: (task.changedFiles ?? []).length,
  }
}

/**
 * 执行进展的一句话（任务行用）。
 *
 * 没有任何执行事实时返回空串 —— 宁可不显示，也不显示「已执行 0 步」
 * （那和计划那个卡死的 `0/M` 一样，只会让人以为「它没动」）。
 */
export function execProgressLabel(exec: ExecSummary): string {
  if (exec.steps === 0) return ''
  return exec.failed > 0
    ? `已执行 ${exec.steps} 步（${exec.failed} 次失败）`
    : `已执行 ${exec.steps} 步`
}

/**
 * 两种进度的**口径说明**（挂在 `title` 上，悬停可见）。
 *
 * 一句话说清它们不是一回事，免得「计划 0/5 步」被读成「任务没进展」。
 */
export const PROGRESS_TITLE =
  '计划 = 模型在计划块里勾选的条数（模型不重发计划块就不会变）· 已执行 = 内核记录的真实工具调用步数'

/*
 * Phase 1 · B1：**计划进度**的措辞（唯一一份）。
 *
 * `done/total` 数的是**模型写的计划**里勾了几条 —— 勾选也是模型自己打的
 * （`- [x]`），**不是**内核记的执行步骤。以前这三处（任务行 / 计划卡 / 恢复卡）
 * 各写各的「N/M 步」「已完成 N/M 步」，读着像「任务执行到 N/M」，
 * 容易把「计划勾了几条」当成「任务完成了多少」。统一叫「计划 N/M 步」，
 * 让用户一眼看出这是计划，执行进度要看时间线里的阶段/工具行。
 *
 * 不显示百分比：分母是模型给的计划条数，不是可信总量（Phase 1 · B2）。
 */
export function planProgressLabel(done: number, total: number): string {
  return `计划 ${done}/${total} 步`
}

/** 任务中心那行「当前步骤」；已结束任务改说结果，不假装还有当前步骤。 */
export function currentStepOf(task: TaskRecord): string {
  const pending = (task.plan ?? []).find((line) => !isPlanDone(line))
  if (pending) return cleanPlanLine(pending)
  if (task.nextAction) return cleanPlanLine(task.nextAction)

  if (task.status === 'completed') return '全部计划已完成'
  if (task.status === 'cancelled') return '任务已取消'
  if (task.status === 'failed') {
    return task.errors.at(-1)?.message || '执行失败'
  }
  const recent = task.steps.at(-1)?.summary
  return recent || '等待下一步'
}

/**
 * 计划里下一步要做什么（**不带兜底**）。
 *
 * 和 `currentStepOf` 的区别：那个是给「任务行一句话」用的，计划没了会退到
 * 「最近一步的摘要」—— 而工具步骤的摘要常常是一段文件内容（read_file 的返回）。
 * 控制台里显示「当前步骤」时那样很难看，所以这里只要计划里的下一步；
 * 没有就老实说没有（AG-042 真机发现：控制台那栏一度显示成一整篇 build.sh）。
 */
export function nextPlanStepOf(task: TaskRecord): string {
  const pending = (task.plan ?? []).find((line) => !isPlanDone(line))
  if (pending) return cleanPlanLine(pending)
  if (task.nextAction) return cleanPlanLine(task.nextAction)
  return ''
}

/** 墙上经过时间：运行中走当前时钟，结束/暂停后停在最后更新时间。 */
export function elapsedMs(task: TaskRecord, now: number): number {
  const end =
    task.status === 'running' ? now : task.finishedAt || task.pausedAt || task.updatedAt || now
  return Math.max(0, end - task.createdAt)
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}时 ${String(minutes).padStart(2, '0')}分`
  if (minutes > 0) return `${minutes}分 ${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

export function formatUpdated(ms: number): string {
  if (!ms) return '未知'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function groupTasks(tasks: TaskRecord[]): Map<TaskRecord['status'], TaskRecord[]> {
  const groups = new Map<TaskRecord['status'], TaskRecord[]>()
  for (const group of TASK_GROUPS) groups.set(group.status, [])
  for (const task of tasks) groups.get(task.status)?.push(task)
  return groups
}
