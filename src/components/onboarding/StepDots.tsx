export type Step = 'welcome' | 'provider' | 'workdir' | 'done'

const ORDER: readonly Step[] = ['welcome', 'provider', 'workdir', 'done']

/** 顶部四个小点：当前位置拉长，走过的实心 */
export function StepDots({ current }: { current: Step }) {
  const at = ORDER.indexOf(current)
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {ORDER.map((step, i) => (
        <span
          key={step}
          className="h-1.5 rounded-full transition-all"
          style={{
            width: current === step ? 20 : 6,
            background: current === step ? 'var(--border-focus)' : 'var(--border-hairline)',
            opacity: i <= at ? 1 : 0.5,
          }}
        />
      ))}
    </div>
  )
}
