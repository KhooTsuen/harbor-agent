import { Children, isValidElement, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SETTINGS_NAV, type SettingsTabDef, type SettingsTabId } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   设置页的公用零件

   抽出来是为了让「工作区」与「过渡弹窗」都只关心「哪一页显示什么」，
   不再重复写布局。

   ★ 导航结构（13 页 / 5 组）在 `settingsNav.ts` —— 那边是唯一真相源，
     这里只 re-export，老的 import 路径一个字都不用改。
   ══════════════════════════════════════════════════════════════ */

export type { SettingsTabId, SettingsTabDef }
export { SETTINGS_NAV, SETTINGS_GROUPS, SETTINGS_HOME, isSettingsTabId } from './settingsNav'

/**
 * 兼容别名 —— 老代码 / 老测试都按 `SETTINGS_TABS` 读这一份清单。
 * 它现在就是 13 页的全集（顺序即导航顺序）。
 */
export const SETTINGS_TABS: readonly SettingsTabDef[] = SETTINGS_NAV

/* ══════════════════════════════════════════════════════════════
   设置视图过滤（P2 #1 沿用）
   · 简洁视图只列非 detailedOnly 的页
   · 但用户被某个入口指到详细页时，那一页必须仍然出现（否则点了没反应）
   ★ 导航（13 页）不做这层过滤 —— 工作区里 13 页始终都在，见 settingsNav.ts。
     这里保留是因为搜索结果要用它决定「在详细视图里」那句提示。
   ══════════════════════════════════════════════════════════════ */

/**
 * 一行设置 —— **一块独立的「亚克力板」**
 *
 * 视觉上刻意做成一块块的，而不是「一列带分隔线的清单」：
 *   · 自己的背景 + 1px 边框 + 圆角 → 有独立的边界
 *   · 玻璃模式下用 `glass` 类 → 磨砂 + 顶边内高光 + 投影，
 *     就是「贴在亚克力玻璃上」的那种感觉（内高光是关键：
 *     亚克力的边会反光，纯半透明看起来只是「变淡」）
 *   · 块与块之间留空隙，不靠分隔线区分
 *
 * 用统一的类名而不是给每处写样式：13 个页面、几十个设置项，
 * 改一处全部生效 —— 这也是它值得单独一个组件的原因。
 */
export function visibleTabsOf(
  tabs: readonly SettingsTabDef[],
  view: 'simple' | 'detailed',
  current: string,
): readonly SettingsTabDef[] {
  return tabs.filter((item) => view === 'detailed' || !item.detailedOnly || item.id === current)
}

/** 简洁视图下被收起来的那些页（顶部要「点名」它们仍在生效） */
export function hiddenTabsOf(tabs: readonly SettingsTabDef[], view: 'simple' | 'detailed') {
  return view === 'detailed' ? [] : tabs.filter((item) => item.detailedOnly)
}

/**
 * 这一行的控件里有没有**文本类**控件（input/select/textarea，排除勾选类）。
 * 有的话标题才给「可点」的样子 —— 开关行里点标题聚焦不到东西，不该装成能点。
 */
function hasField(children: ReactNode): boolean {
  let found = false
  const walk = (node: ReactNode): void => {
    if (found) return
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return
      const type = typeof child.type === 'string' ? child.type : ''
      if (type === 'input' || type === 'select' || type === 'textarea') {
        const kind = String((child.props as { type?: string }).type ?? '')
        if (type !== 'input' || (kind !== 'checkbox' && kind !== 'radio' && kind !== 'file')) {
          found = true
        }
        return
      }
      walk((child.props as { children?: ReactNode }).children)
    })
  }
  walk(children)
  return found
}

export function Row({
  label,
  hint,
  children,
  /** 整行变红（危险操作，比如退出、清空数据） */
  danger,
}: {
  label: string
  hint?: string
  children: ReactNode
  danger?: boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  /*
   * 点标题 = 把光标送进这一行的输入框。
   *
   * 试玩反馈里「设置有些地方点不开」，一类就是这个：标题看着像能点（
   * 别处点标题都会聚焦），点上去却毫无反应，用户会以为坏了。
   *
   * ★ 只挑**文本类**控件：勾选框/单选框不碰 —— 点标题顺手把开关拨了才是真坑。
   */
  const focusField = (): void => {
    const field = rowRef.current?.querySelector<HTMLElement>(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea',
    )
    field?.focus()
  }
  return (
    <div
      ref={rowRef}
      className={cn(
        /* 每个子选项 = 一块独立的亚克力板（用户明确过粒度是子选项，不是节） */
        'acrylic-card flex items-center gap-5',
        danger && 'border-[color-mix(in_srgb,var(--error)_40%,transparent)]',
      )}
    >
      <div className="w-56 shrink-0">
        <p
          onClick={focusField}
          className={cn(
            /* 标签走 meta 档、说明走 dense 档 —— dense 是规格允许的最小档，说明文字不再用 [过渡] 的 12px */
            'text-meta',
            danger ? 'text-[var(--error)]' : 'text-fg-primary',
            /* 有输入框可聚焦时才给「能点」的样子；开关类不给，免得诱导 */
            hasField(children) && 'cursor-text',
          )}
        >
          {label}
        </p>
        {hint ? <p className="mt-0.5 text-dense leading-relaxed text-fg-tertiary">{hint}</p> : null}
      </div>
      {/* 限一个上限：设置弹窗很宽，不限的话输入框会被拉成一条横跨半屏的长条 */}
      {/*
       * justify-end：开关、按钮这类「小控件」自然靠右（设置页的通行做法），
       * 而输入框自己带 w-full，会照旧占满 —— 一个类同时满足两种。
       */}
      <div className="flex min-w-0 max-w-2xl flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

/** 区块标题 —— 只是标签，不包块（块是每个子选项自己的事） */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <h3 className="settings-section-title">
      <span className="settings-section-heading">{children}</span>
      {hint ? <span className="settings-section-hint">{hint}</span> : null}
    </h3>
  )
}

export function SectionCard({
  title,
  hint,
  children,
  danger,
}: {
  title: string
  hint?: string
  children: ReactNode
  danger?: boolean
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <SectionTitle>{title}</SectionTitle>
      {hint ? <p className="mb-1 text-dense leading-relaxed text-fg-tertiary">{hint}</p> : null}
      <div
        className={cn(
          'flex flex-col gap-1.5',
          danger && 'border-[color-mix(in_srgb,var(--error)_40%,transparent)]',
        )}
      >
        {children}
      </div>
    </section>
  )
}

/** 滑块：设置页里有好几个，统一一下 */
export function RangeRow({
  label,
  hint,
  value,
  min,
  max,
  step = 4,
  suffix = '',
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (next: number) => void
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-pill bg-bg-raised accent-[var(--text-primary)]"
        />
        <span className="w-14 shrink-0 text-right font-mono text-2xs text-fg-secondary">
          {value}
          {suffix}
        </span>
      </div>
    </Row>
  )
}
