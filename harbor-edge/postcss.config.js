/**
 * 扩展侧 PostCSS 配置（Phase 1c 第一步建，第二步扩扫描范围）
 *
 * ── 为什么不用项目根那份 ──────────────────────────────────────
 *
 * 根 `postcss.config.js` 调 tailwindcss 时**没指定 config**，Tailwind 会去 cwd
 * 找 `tailwind.config.js` —— 那是**主应用**的配置，content 只扫 `./src/**`，
 * 于是**编不出扩展用到的类**（这是最容易踩的坑）。
 *
 * ── ★ 为什么 theme 在这里展开，而不是另写一个 tailwind.config.ext.js ──
 *
 * 实测（2026-10-15）：另写一份 `tailwind.config.ext.js`、里面用
 * `import base from '../tailwind.config.js'` 取 theme —— **构建直接失败**：
 *
 *     [plugin vite:css] sidepanel.css:undefined:NaN
 *     SyntaxError: [postcss] Unexpected token (6:69)   ← 堆栈全是 sucrase
 *
 * 根因：Tailwind v3 加载 config 文件时用它自己的解析器（堆栈里的 sucrase），
 * **带 `import` 语句的 ESM config 它处理不了**。项目根那份能工作是因为它
 * **只有 `export default`、没有 import**。
 *
 * 解法：**让 Tailwind 收到一个纯对象**（不加载任何文件）。组装放在这里 ——
 * 这个文件由 Vite 正常加载，不受影响。好处顺带有了：theme 只有**一处来源**。
 *
 * ── content 扫哪些（第二步扩过一次，理由写在下面）──────────────
 */

import base from '../tailwind.config.js'

export default {
  plugins: {
    tailwindcss: {
      config: {
        content: [
          /* 扩展自己的代码 */
          './harbor-edge/src/**/*.{ts,tsx,html}',
          /*
           * ★ 主应用的 UI 组件（第二步加）。
           *
           * 侧边栏直接 `import { Button } from '@/components/ui/Button'` —— 类名
           * 散在**那个文件**里（VARIANTS / SIZES 字符串），Tailwind 是**文本扫描**，
           * 不扫到那份文件就编不出 `bg-cta` / `rounded-sm` 这些类，
           * 结果是「组件在、样式全丢」。
           *
           * 只列**实际用到的那几个**，不写整个 `./src/**` —— 免得把主应用
           * 全部类名都编进扩展的 CSS（那是白涨体积）。
           */
          './src/components/ui/Button.tsx',
        ],
        theme: base.theme,
        plugins: base.plugins ?? [],
      },
    },
    autoprefixer: {},
  },
}
