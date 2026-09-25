/* ══════════════════════════════════════════════════════════════
   设计 Token —— 单一事实来源

   这里只有**值**，没有样式。用法：
     · tailwind.config.js 把它映射成 utility（bg-canvas / text-primary …）
     · index.css 把它输出成 CSS 变量（--bg-canvas / --text-primary …）
     · 组件只写 utility 或 var()，不写死颜色

   ⚠️ 改这里的任何一个值，都要同步检查：
     · src/index.css 里的对应变量
     · tailwind.config.js 的映射
     · docs 里的说明
   ══════════════════════════════════════════════════════════════ */

/* ── 色彩 ──────────────────────────────────────────────────── */

export interface ColorScheme {
  bgCanvas: string
  bgSurface: string
  bgRaised: string
  bgHover: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  borderHairline: string
  borderStrong: string
  borderFocus: string
}

/**
 * 暗色。
 *
 * 2026-09-25 起换成 **GitHub Primer** 色板（两层映射的实现见
 * `src/styles/theme-primer-dark.css`）。这里保留的是一份参考快照，
 * 运行时以 CSS 变量为准；chatgpt 主题才是旧「规范基准」的对照。
 */
export const DARK: ColorScheme = {
  bgCanvas: '#0d1117',
  bgSurface: '#151b23',
  bgRaised: '#21262d',
  bgHover: '#21262d',
  textPrimary: '#f0f6fc',
  textSecondary: '#9198a1',
  textTertiary: '#818b98',
  borderHairline: '#212830',
  borderStrong: '#3d444d',
  borderFocus: '#4493f8',
}

/** 说明：亮色主题 */
export const LIGHT: ColorScheme = {
  bgCanvas: '#f9f9f9',
  bgSurface: '#ffffff',
  bgRaised: '#f1f1f1',
  bgHover: '#ededed',
  textPrimary: '#0d0d0d',
  textSecondary: '#5d5d5d',
  textTertiary: '#8e8ea0',
  borderHairline: 'rgba(0,0,0,0.05)',
  borderStrong: 'rgba(0,0,0,0.12)',
  borderFocus: '#0d0d0d',
}

/** 对齐 ChatGPT 桌面端那套（规范给的基准值） */
export const CHATGPT_DARK: ColorScheme = {
  bgCanvas: '#212121',
  bgSurface: '#2f2f2f',
  bgRaised: '#383838',
  bgHover: '#343434',
  textPrimary: '#ececec',
  textSecondary: '#b4b4b4',
  textTertiary: '#8e8ea0',
  borderHairline: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',
  borderFocus: '#ececec',
}

/**
 * 语义色。
 * **只允许用在 Diff / 错误 / 成功三处**，不做装饰。
 */
export const SEMANTIC = {
  diffAdd: '#3fb950',
  diffRemove: '#f85149',
  error: '#f85149',
  success: '#3fb950',
  warning: '#d29922',
} as const

/* ── 字体 ──────────────────────────────────────────────────── */

/**
 * 纯系统字体栈 —— 不加载任何 Web 字体。
 * Inter 那套字体文件还留在 src/assets/fonts（想用可以在 index.css 里开回来），
 * 但默认不加载：规范要求"禁止加载自定义 Web 字体"。
 */
export const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif"

export const FONT_MONO = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'Cascadia Mono', monospace"

/* ── 字号：三层 ────────────────────────────────────────────── */

export const FONT_SIZE = {
  /** 辅助：14px */
  meta: { size: 14, lineHeight: 1.43 },
  /** 正文：16px */
  body: { size: 16, lineHeight: 1.5 },
  /** 标题：24px（**上限**，禁止更大） */
  title: { size: 24, lineHeight: 1.33 },
} as const

/** 面板里的小字（线程行、状态栏）允许用 13px，这是唯一的例外 */
export const FONT_SIZE_DENSE = 13

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
} as const

/* ── 间距：4px 网格 ────────────────────────────────────────── */

export const SPACING = {
  /** 元素内距 / 紧凑间距 */
  xs: 6,
  /** 常规间距 */
  sm: 10,
  /** 区块内距 */
  md: 16,
  /** 区块之间 */
  lg: 24,
} as const

/* ── 圆角 ──────────────────────────────────────────────────── */

export const RADIUS = {
  /** 统一值：按钮、侧栏项、卡片、输入框 */
  base: 10,
  /** 小控件（kbd / chip） */
  small: 6,
  /** 仅主 CTA 用 */
  pill: 9999,
} as const

/* ── 动效 ──────────────────────────────────────────────────── */

export const MOTION = {
  fast: 150,
  base: 250,
  slow: 350,
} as const

export const EASING = {
  out: 'cubic-bezier(0, 0, 0.2, 1)',
} as const

/* ── 悬停 / 按下遮罩 ───────────────────────────────────────── */

export const OVERLAY = {
  hoverLight: 'rgba(0,0,0,0.05)',
  activeLight: 'rgba(0,0,0,0.1)',
  hoverDark: 'rgba(255,255,255,0.06)',
  activeDark: 'rgba(255,255,255,0.12)',
} as const

/* ── 层级 z-index ──────────────────────────────────────────── */

export const Z = {
  base: 0,
  sticky: 30,
  dropdown: 40,
  overlay: 60,
  modal: 70,
  toast: 80,
} as const

/* ── 布局 ──────────────────────────────────────────────────── */

export const LAYOUT_TOKENS = {
  topbarHeight: 40,
  statusbarHeight: 28,
  sidebar: { min: 220, max: 320, default: 240, collapsed: 48 },
  rightPanel: { min: 320, max: 480, default: 360 },
  contentMaxWidth: 760,
  dialogMaxWidth: 760,
  composerMinHeight: 52,
  composerMaxHeight: 200,
  controlHeight: 28,
  compactControlHeight: 24,
  panelPadding: 12,
  sectionGap: 12,
} as const
