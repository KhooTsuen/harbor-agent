/**
 * 扩展侧 PostCSS 配置（Phase 1c 第一步）
 *
 * ── 为什么不用项目根那份 ──────────────────────────────────────
 *
 * 根 `postcss.config.js` 调 tailwindcss 时**没指定 config**，Tailwind 会去 cwd
 * 找 `tailwind.config.js` —— 那是**主应用**的配置，content 只扫 `./src/**`，
 * 于是**编不出扩展用到的类**（这是本步最容易踩的坑）。
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
 * **只有 `export default`、没有 import**（唯一差别就在这）。
 *
 * 解法：**让 Tailwind 收到一个纯对象**（不加载任何文件）。组装放在这里 ——
 * 这个文件由 Vite 正常加载（TS/ESM 都走 Vite 自己的管线），不受影响。
 * 好处顺带有了：theme 只有**一处来源**（父目录那份），不会被抄成两份漂掉。
 */

import base from '../tailwind.config.js'

/*
 * 扩展自己的 Tailwind 配置。
 *
 * `content` 只扫扩展代码（相对项目根，构建固定从根跑）：
 *   ① 不把扩展的类渗进主应用产物；② 主应用构建不用多扫一遍扩展。
 *
 * `theme` 从主 config **继承**（同一份对象）—— 主 config 的色值是
 * `rgb(var(--x-rgb) / <alpha-value>)` 这种**通道模式**，值本身在
 * `src/index.css` 的 CSS 变量里（所以 sidepanel.css 要 @import 它）。
 */
export default {
  plugins: {
    tailwindcss: {
      config: {
        content: ['./harbor-edge/src/**/*.{ts,tsx,html}'],
        theme: base.theme,
        plugins: base.plugins ?? [],
      },
    },
    autoprefixer: {},
  },
}
