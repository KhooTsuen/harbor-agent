import { useAppStore } from '@/stores/useAppStore'
import { TaskList } from './TaskList'

export function StatePanel() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
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
        {/*
          任务放在最前（AG-011）—— 以前这一格没有 conversationState 就整块空白，
          而任务列表恰恰是「刚让它干完活」最想看的东西，跟对话摘要有没有生成无关。
        */}
        <section>
          <h3 className="text-2xs text-fg-tertiary">任务</h3>
          <div className="mt-1">
            <TaskList />
          </div>
        </section>

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
