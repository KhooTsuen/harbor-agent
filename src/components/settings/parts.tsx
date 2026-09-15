import type { ReactNode } from 'react'
import {
  BrainCircuit,
  Cpu,
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
