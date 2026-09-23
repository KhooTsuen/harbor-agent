import { useState } from 'react'
import { BarChart3, ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { abortChat, pauseChat } from '@/lib/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { labelOf, statusOfTask } from '@/lib/statusLanguage'
import { elapsedMs, formatDuration, nextPlanStepOf } from './taskCenterModel'
import { TaskTokenBadge } from './TaskTokenBadge'

/* ══════════════════════════════════════════════════════════════
   控制台（AG-042）

   文档要的那一屏：

     任务 / 状态 / 当前步骤 / 运行时间 / Tool Calls / Retry / 权限 / 模型 / Token

     操作：[Pause] [Stop] [查看计划] [查看 Tool] [查看 Diff] [调整权限]

   放在任务行的「详情」里（默认折叠）—— 这一屏信息密度高，摊在外面会把
   任务中心变成仪表盘（AG-030 的账：默认只留当前任务/步骤/结果）。

   ── 三个动作分别去哪 ──
     · 查看计划 → 就在这里（详情里有计划版本卡片），展开即可
     · 查看 Tool → 底部面板的「日志」流水（AG-042 顺手把它搬进了 store，
       否则这里够不着）
     · 查看 Diff → 右栏「审查」标签（AG-036 那套）
     · 调整权限 / Pause / Stop → 真动作：前两个打给正在跑的那条对话
   ══════════════════════════════════════════════════════════════ */

export function TaskConsole({ task, now }: { task: TaskRecord; now: number }) {
  const [open, setOpen] = useState(false)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const openBottomPanel = useUIStore((s) => s.openBottomPanel)
  const openSettings = useUIStore((s) => s.openSettings)
  const resumeTask = useThreadStore((s) => s.resumeTask)
  /* 权限是主进程配置里的（设置 → 安全里的那一档），不是渲染层设置 */
  const permission = useConfigStore((s) => s.config?.tools?.permission ?? 'ask')

  /* ★ 只用计划里的下一步 —— 别退到「最近一步的摘要」（那是文件内容，见模型层注释） */
  const currentStep = nextPlanStepOf(task)
  const hasPlan = (task.plan ?? []).length > 0
  const running = task.status === 'running' || task.status === 'waiting_user'

  const rows: Array<[string, string]> = [
    ['状态', labelOf(statusOfTask(task.status))],
    ['当前步骤', currentStep || (hasPlan ? '计划已做完' : '（没有计划）')],
    ['运行时间', formatDuration(elapsedMs(task, now))],
    ['Tool Calls', String(task.steps.length)],
    /* 分母是**单个工具**的重试上限，而分子是整轮的重试次数 —— 别写成「6 / 3」那种误导 */
    ['Retry', `${task.retries ?? 0} 次`],
    ['权限', PERMISSION_TEXT[permission] ?? permission],
    ['模型', task.model || '—'],
    ['Token', task.tokens ? `${Math.round(task.tokens / 1000)}K` : '—'],
  ]

  return (
    <div className="mb-1.5 rounded-sm border border-line-hairline bg-bg-base/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-2xs text-fg-tertiary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <BarChart3 size={11} />
        控制台
        {!open ? (
          <span className="ml-auto font-mono">
            {task.steps.length} Tool · {formatDuration(elapsedMs(task, now))}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-t border-line-hairline px-2 py-1.5">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <dt className="text-fg-tertiary">{label}</dt>
                <dd className="min-w-0 truncate font-mono text-fg-secondary" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {/* AG-044：上面那行「Token」只是个总数，这里说清入 / 出各多少 */}
          <TaskTokenBadge task={task} />

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {running ? (
              <>
                {/* 打断正在跑的那条对话 —— 用的就是输入框旁那两个按钮的同一套接口 */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void pauseChat(task.sessionId)}
                >
                  暂停
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void abortChat(task.sessionId)}>
                  停止
                </Button>
              </>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setActiveRightTab('diff')}>
              查看 Diff
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openBottomPanel('log')}>
              查看 Tool
            </Button>
            {/* 落到「权限与安全」那一页 —— 只打开设置、停在「通用」，用户找不到权限在哪 */}
            <Button variant="ghost" size="sm" onClick={() => openSettings('access')}>
              调整权限
            </Button>
            {task.status === 'paused' ? (
              <Button variant="ghost" size="sm" onClick={() => resumeTask(task.id)}>
                继续
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const PERMISSION_TEXT: Record<string, string> = {
  ask: '询问',
  full: '完全访问',
  readonly: '只读',
}
