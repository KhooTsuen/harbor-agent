import { ArrowRight } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { PerfPanel } from '@/components/layout/state/PerfPanel'

/* ══════════════════════════════════════════════════════════════
   状态面板：**当前这条对话的长期状态**（话题 / 目标 / 约束 / 下一步…）

   AG-030：这里原来还挂着一份「任务列表」（TaskList）—— 和右栏「任务」标签
   里的任务中心是同一份东西的第二遍显示，而且两处用的是**两套词**
   （这边「等你确认 / 已放弃」，那边「等待中 / 已取消」）。同一份状态
   出现两次、措辞还不一致，正是「重复状态标签」。
   现在任务只在任务中心一处显示，这里留一个能点过去的入口。
   ══════════════════════════════════════════════════════════════ */

export function StatePanel() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const state = thread?.conversationState
  const groups: Array<[string, string | string[]]> = state
    ? [
        ['主题', state.topic],
        ['目标', state.goal],
        ['当前焦点', state.currentFocus],
        ['已定决定', state.decisions],
        ['约束', state.constraints],
        ['未解决问题', state.openQuestions],
        ['下一步', state.nextStep],
      ]
    : []

  return (
    <div aria-label="状态面板" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        {/* 任务与进度在「任务」标签里 —— 这里只指路，不再重复列一遍 */}
        <button
          type="button"
          onClick={() => setActiveRightTab('tasks')}
          className="flex w-full items-center gap-1.5 rounded-sm border border-line-hairline bg-bg-raised/40 px-2.5 py-2 text-left text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          任务、进度、可撤销的改动都在「任务」标签里
          <ArrowRight size={12} className="ml-auto shrink-0" />
        </button>

        {/* AG-037：时间花在哪一段 —— 和「现在卡在哪」本来就是同一件事 */}
        <PerfPanel threadId={thread?.id} />

        {state ? (
          groups.map(([label, value]) => (
            <section key={label}>
              <h3 className="text-2xs text-fg-tertiary">{label}</h3>
              {Array.isArray(value) ? (
                <ul className="mt-1 flex flex-col gap-1 text-xs text-fg-secondary">
                  {value.length ? value.map((item) => <li key={item}>· {item}</li>) : <li>无</li>}
                </ul>
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-xs text-fg-secondary">
                  {value || '无'}
                </p>
              )}
            </section>
          ))
        ) : (
          <p className="text-xs text-fg-tertiary">继续几轮对话后，这里会显示当前状态。</p>
        )}
      </div>
    </div>
  )
}
