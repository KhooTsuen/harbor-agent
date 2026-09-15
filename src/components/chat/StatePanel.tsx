import { useAppStore } from '@/stores/useAppStore'

export function StatePanel() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const state = thread?.conversationState
  if (!state)
    return <p className="p-4 text-2xs text-fg-tertiary">继续几轮对话后，这里会显示当前状态。</p>
  const groups: Array<[string, string | string[]]> = [
    ['主题', state.topic],
    ['目标', state.goal],
    ['当前焦点', state.currentFocus],
    ['已定决定', state.decisions],
    ['约束', state.constraints],
    ['未解决问题', state.openQuestions],
    ['下一步', state.nextStep],
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        {groups.map(([label, value]) => (
          <section key={label}>
            <h3 className="text-2xs text-fg-tertiary">{label}</h3>
            {Array.isArray(value) ? (
              <ul className="mt-1 flex flex-col gap-1 text-xs text-fg-secondary">
                {value.length ? value.map((item) => <li key={item}>· {item}</li>) : <li>无</li>}
              </ul>
            ) : (
              <p className="mt-1 whitespace-pre-wrap text-xs text-fg-secondary">{value || '无'}</p>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
