import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
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
  return (
    <div
      className={cn(
        /* 不带自己的板：所在的「节」是一整块，见 index.css 的 .settings-body。
           行与行之间**不放分隔线** —— 要的是「一整块里排着几项」。 */
        'flex items-center gap-5 px-3.5 py-2.5',
        danger && 'border-[color-mix(in_srgb,var(--error)_40%,transparent)]',
      )}
    >
      <div className="w-56 shrink-0">
        <p className={cn('text-dense', danger ? 'text-[var(--error)]' : 'text-fg-primary')}>
          {label}
        </p>
        {hint ? <p className="mt-0.5 text-2xs leading-relaxed text-fg-tertiary">{hint}</p> : null}
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

/** 区块标题 —— 贴在块的上方，不画分隔线（分隔线是「清单」的语言） */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="settings-section-title">
      <span
        className="size-1 shrink-0 rounded-full"
        style={{ background: 'color-mix(in srgb, var(--accent-blue) 70%, transparent)' }}
        aria-hidden="true"
      />
      {children}
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
      {hint ? <p className="-mt-1 mb-1 text-2xs leading-relaxed text-fg-tertiary">{hint}</p> : null}
      <div
        className={cn(
          'acrylic-card flex flex-col gap-1.5 rounded-large p-1.5',
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
