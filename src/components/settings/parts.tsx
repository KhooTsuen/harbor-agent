import type { ReactNode } from 'react'
import {
  BarChart3,
  BrainCircuit,
  Cpu,
  Database,
  Info,
  FolderOpen,
  Keyboard,
  Palette,
  Plug,
  Puzzle,
  Settings2,
  Shield,
  SlidersHorizontal,
  Lock,
} from 'lucide-react'

/* ══════════════════════════════════════════════════════════════
   设置页的公用零件

   抽出来是为了让 SettingsModal 只关心「哪个标签页显示什么」，
   不再重复写布局。
   ══════════════════════════════════════════════════════════════ */

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'scenes'
  | 'models'
  | 'tools'
  | 'security'
  | 'skills'
  | 'memory'
  | 'mcp'
  | 'usage'
  | 'data'
  | 'project'
  | 'thread'
  | 'about'

export const SETTINGS_TABS: readonly {
  id: SettingsTabId
  label: string
  icon: typeof Settings2
}[] = [
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'scenes', label: '模型与提示词', icon: SlidersHorizontal },
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'tools', label: '工具', icon: Shield },
  { id: 'security', label: '安全', icon: Lock },
  { id: 'skills', label: '技能', icon: Puzzle },
  { id: 'memory', label: '记忆', icon: BrainCircuit },
  { id: 'mcp', label: '扩展', icon: Plug },
  { id: 'usage', label: '用量', icon: BarChart3 },
  { id: 'data', label: '数据', icon: Database },
  { id: 'project', label: '项目上下文', icon: FolderOpen },
  { id: 'thread', label: '本次会话', icon: SlidersHorizontal },
  { id: 'about', label: '关于', icon: Info },
] as const

/** 一行设置：左边标签 + 说明，右边控件 */
export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-5 py-3">
      <div className="w-52 shrink-0">
        <p className="text-dense text-fg-primary">{label}</p>
        {hint ? <p className="mt-0.5 text-2xs leading-relaxed text-fg-tertiary">{hint}</p> : null}
      </div>
      {/* 限一个上限：设置弹窗很宽，不限的话输入框会被拉成一条横跨半屏的长条 */}
      <div className="min-w-0 max-w-2xl flex-1">{children}</div>
    </div>
  )
}

/** 区块标题 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-2 border-b border-line-hairline pb-1.5 text-2xs uppercase tracking-wide text-fg-tertiary">
      {children}
    </h3>
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
