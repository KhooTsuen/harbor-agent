/** @type {import('tailwindcss').Config} */

/*
 * Token 映射
 *
 * 值的**唯一来源**是 src/constants/design.ts，这里只做「名字 → CSS 变量」的映射。
 * 实际值由 src/index.css 输出成 CSS 变量（因为要支持多主题切换）。
 *
 * 命名说明：
 *   bg-canvas / bg-surface / bg-raised   ← 新的语义名，推荐用
 *   bg-base / bg-elevated / bg-card      ← 旧名，保留是为了不打断现有组件
 *                                            （它们指向同一批变量，可以逐步迁移）
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * 想用透明度修饰（如 bg-bg-raised/40）的颜色必须写成
         * `rgb(var(--x-rgb) / <alpha-value>)` —— Tailwind 3 对纯 `var(--x)` 颜色
         * 会把 `/NN` **静默丢掉**（类不生成也不报错）。2026-09-25 主题轮发现
         * 存量 30+ 处这类背景一直没生效；通道值在各主题的 index.css / 主题文件里。
         */
        canvas: 'rgb(var(--bg-canvas-rgb) / <alpha-value>)',
        surface: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
        raised: 'rgb(var(--bg-raised-rgb) / <alpha-value>)',

        bg: {
          canvas: 'rgb(var(--bg-canvas-rgb) / <alpha-value>)',
          surface: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          raised: 'rgb(var(--bg-raised-rgb) / <alpha-value>)',
          hover: 'rgb(var(--bg-hover-rgb) / <alpha-value>)',
          overlay: 'var(--bg-overlay)',
          /* Primer 层：输入控件底比卡片亮一档（#21262d vs #151b23）；active 是按下/更亮档 */
          input: 'var(--bg-input)',
          active: 'var(--bg-active)',
          /* 旧名，指向同一批变量 */
          base: 'rgb(var(--bg-canvas-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          card: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          glass: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
        },

        fg: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          inverse: 'var(--text-inverse)',
          /* 色彩强调底（accent/danger…）上的前景文字 */
          'on-emphasis': 'var(--fg-on-emphasis)',
        },

        line: {
          hairline: 'var(--border-hairline)',
          strong: 'var(--border-strong)',
          focus: 'var(--border-focus)',
          /* 旧名 */
          subtle: 'var(--border-hairline)',
        },

        /* 语义色：只用于 Diff / 错误 / 成功 */
        diff: {
          add: 'var(--diff-add)',
          remove: 'var(--diff-remove)',
        },
        error: 'var(--error)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        /* danger 要支持 /NN（Button 的 hover:bg-danger/10 等）—— 走通道模式 */
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        info: 'var(--text-secondary)',

        /*
         * 强调色。补这一条是因为 `text-accent` 在 ProgressTimeline 里早就用了 ——
         * 但配置里一直没有 `accent` 这个色，于是那个类**什么也没生成**，
         * 转圈图标一直是继承父级颜色（AG-027 给「当前步骤」加实心 ● 时发现的）。
         */
        accent: 'var(--accent-blue)',
        /* Primer 层的强调衍生（名字保持扁平键，避免动上面那条字符串断言） */
        'accent-hover': 'var(--accent-hover)',
        'accent-subtle': 'var(--accent-subtle)',
        'accent-border': 'var(--accent-border)',

        /* 完成/分叉语义色（Primer done，紫） */
        done: 'var(--done)',

        /* 主按钮（反色） */
        cta: {
          DEFAULT: 'var(--cta-bg)',
          fg: 'var(--cta-fg)',
          hover: 'var(--cta-bg-hover)',
        },
      },

      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },

      /*
       * 字号：规范要求三层（14 / 16 / 24）。
       * 旧的 11/12/13/18/20 全部保留但在下面标注 [过渡]，
       * 新写的组件请用 meta / body / title / dense。
       */
      fontSize: {
        meta: ['var(--text-meta)', { lineHeight: 'var(--leading-meta)' }],
        body: ['var(--text-body)', { lineHeight: 'var(--leading-body)' }],
        title: ['var(--text-title)', { lineHeight: 'var(--leading-title)' }],
        dense: ['var(--text-dense)', { lineHeight: 'var(--leading-meta)' }],

        /*
         * 一律用 rem（基准 16px）。
         * 以前这里是写死的 px —— 结果设置里的「字号缩放」完全不起作用，
         * 而且笔记本上普遍偏小。改 rem 之后，根字号一动整屏跟着动。
         */
        '2xs': ['0.75rem', { lineHeight: '1.45' }],
        xs: ['0.8125rem', { lineHeight: '1.5' }],
        sm: ['0.875rem', { lineHeight: '1.5' }],
        base: ['0.9375rem', { lineHeight: '1.55' }],
        md: ['1rem', { lineHeight: '1.5' }],
        lg: ['1.125rem', { lineHeight: '1.45' }],
        xl: ['1.25rem', { lineHeight: '1.4' }],
        '2xl': ['1.5rem', { lineHeight: '1.35' }],
      },

      /* 间距：4px 网格 */
      spacing: {
        xs: 'var(--space-xs)',
        sm: 'var(--space-sm)',
        md: 'var(--space-md)',
        lg: 'var(--space-lg)',

        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        5: '20px',
        6: '24px',
        8: '32px',
        10: '40px',
        12: '48px',
        16: '64px',
      },

      /* 圆角：统一 10px，小控件 6px，仅 CTA 用胶囊 */
      borderRadius: {
        DEFAULT: 'var(--radius-base)',
        base: 'var(--radius-base)',
        small: 'var(--radius-small)',
        pill: 'var(--radius-pill)',
        /* [过渡] 旧名 */
        sm: 'var(--radius-small)',
        md: 'var(--radius-base)',
        lg: 'var(--radius-base)',
      },

      /* 阴影**只用于浮层**，不用来建立层级 */
      boxShadow: {
        popover: 'var(--glass-shadow)',
        modal: '0 16px 40px rgb(0 0 0 / 0.35)',
        /* [过渡] 旧名 */
        low: 'var(--glass-shadow)',
        mid: 'var(--glass-shadow)',
        high: 'var(--glass-shadow)',
        inset: 'inset 0 1px 0 var(--glass-inset)',
      },

      transitionDuration: {
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        slow: 'var(--motion-slow)',
      },

      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },

      zIndex: {
        base: '0',
        sticky: '30',
        dropdown: '40',
        overlay: '60',
        modal: '70',
        /* 弹窗里打开的菜单（如设置页选模型）要盖在弹窗上面 */
        popover: '75',
        toast: '80',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },

      animation: {
        'fade-in': 'fade-in var(--motion-base) var(--ease-out)',
        'slide-up': 'slide-up var(--motion-base) var(--ease-out)',
        'slide-in-right': 'slide-in-right var(--motion-base) var(--ease-out)',
        spin: 'spin 900ms linear infinite',
        pulse: 'pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
