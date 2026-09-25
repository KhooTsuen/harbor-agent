import { Children, isValidElement, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  BrainCircuit,
  Cpu,
  UserRound,
  Database,
  Info,
  Palette,
  Puzzle,
  Settings2,
  Shield,
  SlidersHorizontal,
} from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   设置页的公用零件

   抽出来是为了让 SettingsModal 只关心「哪个标签页显示什么」，
   不再重复写布局。
   ══════════════════════════════════════════════════════════════ */

export type SettingsTabId =
  | 'profile'
  | 'general'
  | 'appearance'
  | 'conversation'
  | 'models'
  | 'access'
  | 'datausage'
  | 'extension'
  | 'memory'
  | 'about'

/* ══════════════════════════════════════════════════════════════
   设置的分组与顺序

   原来是 15 个平铺的标签，扫不完也找不到东西。现在按两件事重排：

     ① **按「用户想干什么」分组**，不按实现模块分。
        最典型的：「权限三档」原来在「工具」、「文件访问范围」在「安全」——
        同一件事劈成两半，用户得两边找。现在合成「权限与安全」。
     ② **常用 / 高级分组**，用标题隔开。
        90% 的时间在改前四个，后几个配置一次就不动了。
        「关于」单独放最后（几乎所有软件都这样）。

   15 → 9 个。合并的对应关系：
     通用       ← 通用 + 快捷键
     对话       ← 模型与提示词 + 项目上下文 + 本次会话
     模型       ← 模型（供应商 + 助手参数）
     权限与安全  ← 工具 + 安全
     数据与用量  ← 用量 + 数据
     扩展       ← 技能 + 扩展(MCP)
     外观 / 记忆 / 关于  原样
   ══════════════════════════════════════════════════════════════ */

export const SETTINGS_TABS: readonly {
  id: SettingsTabId
  label: string
  icon: typeof Settings2
  /** 分组标题（null = 不分组，直接列在最下面） */
  group: string | null
}[] = [
  { id: 'profile', label: '个人资料', icon: UserRound, group: '常用' },
  { id: 'general', label: '通用', icon: Settings2, group: '常用' },
  { id: 'appearance', label: '外观', icon: Palette, group: '常用' },
  { id: 'conversation', label: '对话', icon: SlidersHorizontal, group: '常用' },
  { id: 'models', label: '模型', icon: Cpu, group: '常用' },

  { id: 'access', label: '权限与安全', icon: Shield, group: '高级' },
  { id: 'datausage', label: '数据与用量', icon: Database, group: '高级' },
  { id: 'extension', label: '扩展', icon: Puzzle, group: '高级' },
  { id: 'memory', label: '记忆', icon: BrainCircuit, group: '高级' },

  { id: 'about', label: '关于', icon: Info, group: null },
] as const

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
 * 用统一的类名而不是给每处写样式：9 个标签页、几十个设置项，
 * 改一处全部生效 —— 这也是它值得单独一个组件的原因。
 */
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
        'acrylic-card flex items-center gap-5 rounded-base px-3.5 py-3',
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
