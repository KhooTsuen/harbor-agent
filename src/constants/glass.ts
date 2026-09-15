/* ══════════════════════════════════════════════════════════════
   玻璃拟态 Token

   三级强度，各司其职。**值都是按规范给的**：
     opacity 0.65 / 0.72 / 0.78，blur 16 / 24 / 32，saturate 140 / 160

   ⚠️ 一个绕不开的技术事实（写在文档里，也写在这里，免得以后有人困惑）：
   "玻璃表面文字对比度 ≥ 12:1" 在**真·半透明**表面上无法数学保证。
   最坏情况（背后是纯白、表面是 0.72 的 #212121）：
       0.72 × 33 + 0.28 × 255 ≈ 95  →  文字 #f8f8f8 对比度 ≈ 5.5:1
   要稳定 ≥ 12:1 只有两条路：
     ① 把不透明度提到 0.95+（那就不是玻璃了）
     ② 表面恒定垫一层 canvas 底色（见 index.css 的 `--glass-underlay`）
   本项目选 ②：玻璃表面会叠一层当前主题的 canvas 色，把最坏情况压住，
   同时保留模糊带来的"透"的感觉。prefers-contrast: more 时直接退成纯色。
   ══════════════════════════════════════════════════════════════ */

export type GlassLevelId = 'subtle' | 'medium' | 'strong'

export interface GlassLevel {
  id: GlassLevelId
  label: string
  /** 表面不透明度（亮/暗各自微调） */
  opacity: { dark: number; light: number }
  blurPx: number
  saturate: number
  /** 用在哪 */
  usage: string
}

export const GLASS_LEVELS: readonly GlassLevel[] = [
  {
    id: 'subtle',
    label: '轻',
    opacity: { dark: 0.65, light: 0.65 },
    blurPx: 16,
    saturate: 140,
    usage: '侧边栏、状态栏',
  },
  {
    id: 'medium',
    label: '中',
    opacity: { dark: 0.72, light: 0.72 },
    blurPx: 24,
    saturate: 140,
    usage: 'Composer、右侧面板',
  },
  {
    id: 'strong',
    label: '强',
    opacity: { dark: 0.78, light: 0.78 },
    blurPx: 32,
    saturate: 160,
    usage: '设置弹窗、Dropdown、Popover',
  },
] as const

export function glassLevel(id: GlassLevelId): GlassLevel {
  const found = GLASS_LEVELS.find((g) => g.id === id)
  return found ?? GLASS_LEVELS[1]
}

/* ── 各状态的增量（规范给的值）───────────────────────────── */

export const GLASS_STATE = {
  /** 悬停：透明度 +0.03，边框亮度 +0.02 */
  hoverOpacityDelta: 0.03,
  hoverBorderDelta: 0.02,
  /** 按下：透明度 +0.06，内高光增强 */
  activeOpacityDelta: 0.06,
} as const

/* ── 边框 / 高光 / 阴影（规范给的值）────────────────────── */

export const GLASS_DECOR = {
  borderDark: 'rgba(255,255,255,0.08)',
  borderLight: 'rgba(0,0,0,0.06)',
  insetDark: 'rgba(255,255,255,0.06)',
  insetLight: 'rgba(255,255,255,0.6)',
  shadowDark: '0 4px 12px rgba(0,0,0,0.3)',
  shadowLight: '0 4px 12px rgba(0,0,0,0.08)',
} as const

/* ── 硬上限：透明度不允许超过这个值（规范禁止）──────────── */

export const GLASS_OPACITY_MAX = 0.78
