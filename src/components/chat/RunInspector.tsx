import type { ReactNode } from 'react'
import { Flag } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { colorOf, iconOf, labelOf, statusOfTask, type UiStatus } from '@/lib/statusLanguage'
import { buildRunTimeline, type RunTimelineEntry, type RunTimelineKind } from '@/lib/runTimeline'
import { elapsedMs, formatDuration } from './taskCenterModel'
import { TaskTokenBadge } from './TaskTokenBadge'

/* ══════════════════════════════════════════════════════════════
   Run Inspector（AG-048）—— 一屏看懂一次任务执行

     ┌ 标题 · 状态 · 用时 · 步数
     ├ 成本：token（有入 / 出就一起显示）
     ├ 时间线：工具 / 错误 / 检查点，各一种图标与颜色
     └ 出错与重试：错误条数 + 最后一条原文、重试次数

   ── **只读**，这是设计约束不是疏漏 ──
     面板里**没有任何可写动作**：没有重跑、没有停止、没有改状态、没有 IPC。
     数据全部来自 store 里传进来的 `task`（`TaskRecord`），渲染过程零副作用。
     要停 / 要重跑，去控制台那排按钮 —— 那些走 `lib/backend`，这里够不着，
     也就不可能误触。挂在控制台里只是为了少开一层面板（AG-030 的账：
     任务中心不堆仪表盘）。

   ── 颜色与措辞 ──
     一律取自 `lib/statusLanguage`（`colorOf` / `labelOf` / `iconOf`），
     这里**不写任何色值、不写任何状态词** —— `statusLanguage.test.ts` 盯着这条。
     工具 / 错误 / 检查点三类不是「状态」，所以三类名放在下面那张表里，
     但它们各自的**颜色**仍然来自状态语言表。
   ══════════════════════════════════════════════════════════════ */

const KIND_TEXT: Record<RunTimelineKind, string> = {
  step: '工具',
  error: '错误',
  checkpoint: '检查点',
}

/** 一条流水该用哪种语义色：工具看成功与否，错误恒为失败，检查点用强调色区分开 */
function statusOfEntry(entry: RunTimelineEntry): UiStatus {
  if (entry.kind === 'step') return entry.ok ? 'completed' : 'failed'
  if (entry.kind === 'error') return 'failed'
  return 'running'
}

/** 检查点不是「状态」，用旗子（`STATUS_META` 那套图标里没有能表达「标记」的） */
function entryIcon(entry: RunTimelineEntry): ReactNode {
  if (entry.kind === 'checkpoint') return <Flag size={11} />
  const Icon = iconOf(statusOfEntry(entry))
  return <Icon size={11} />
}

/** 同一次任务里的时间，到秒就够；跨天的情况交给日期不在这一屏解决 */
function clockOf(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function RunInspector({ task, now }: { task: TaskRecord; now: number }) {
  const timeline = buildRunTimeline(task)
  const status = statusOfTask(task.status)
  const errors = task.errors ?? []
  const retries = Number(task.retries) || 0
  const lastError = errors.at(-1)?.message ?? ''

  return (
    <div className="mt-2 rounded-sm border border-line-hairline bg-bg-base/50 p-2">
      {/* ── 头部：谁 / 什么状态 / 跑了多久 / 走了几步 ── */}
      <div className="flex items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-fg-primary"
          title={task.title || task.goal}
        >
          {task.title || task.goal || '未命名任务'}
        </span>
        <span className="shrink-0 text-2xs" style={{ color: colorOf(status) }}>
          {labelOf(status)}
        </span>
      </div>

      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
        <Fact label="用时" value={formatDuration(elapsedMs(task, now))} />
        <Fact label="步数" value={`${(task.steps ?? []).length} 步`} />
      </dl>

      {/* ── 成本：和任务行里那行用量同一个来源、同一套写法 ── */}
      <TaskTokenBadge task={task} />
      {(Number(task.tokens) || 0) <= 0 &&
      (Number(task.tokensIn) || 0) <= 0 &&
      (Number(task.tokensOut) || 0) <= 0 ? (
        <p className="mt-1.5 font-mono text-2xs text-fg-tertiary">token（未记录）</p>
      ) : null}

      {/* ── 时间线 ── */}
      <div className="mt-2 text-2xs text-fg-tertiary">执行流水</div>
      {timeline.length === 0 ? (
        <p className="mt-1 text-2xs text-fg-tertiary">这个任务还没有可展示的记录</p>
      ) : (
        <ul className="mt-1 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {timeline.map((entry, index) => {
            /* 语义色只算一次（图标和文字要用同一个）；摘要为空时悬停提示退回标题 */
            const tone = colorOf(statusOfEntry(entry))
            const tip = entry.detail || entry.title
            return (
              <li key={`${entry.kind}-${index}`} className="flex items-baseline gap-1.5">
                <span className="shrink-0" style={{ color: tone }}>
                  {entryIcon(entry)}
                </span>
                <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                  {/* 没有可信时间的条目不编时间 —— 老实说不知道 */}
                  {entry.atKnown ? clockOf(entry.at) : '时间未知'}
                </span>
                <span className="shrink-0 text-2xs text-fg-tertiary">{KIND_TEXT[entry.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-2xs" title={tip}>
                  <span className="text-fg-primary">{entry.title}</span>
                  {entry.detail ? <span className="text-fg-tertiary"> · {entry.detail}</span> : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {/* ── 出错与重试：条数 + 最后一条原文（整篇在时间线里） ── */}
      <div className="mt-2 flex items-baseline gap-3 text-2xs">
        <span className="text-fg-tertiary">出错与重试</span>
        <span className="font-mono text-fg-secondary">错误 {errors.length} 条</span>
        <span className="font-mono text-fg-secondary">重试 {retries} 次</span>
      </div>
      {lastError ? (
        <p className="mt-0.5 text-2xs text-fg-tertiary" title={lastError}>
          最近一条：
          <span className="font-mono"> {lastError.split('\n')[0]}</span>
        </p>
      ) : null}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-fg-secondary" title={value}>
        {value}
      </dd>
    </div>
  )
}
