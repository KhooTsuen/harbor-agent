/**
 * 扩展侧 Vite 配置（Phase 1c 第一步建，第二步补齐 alias 与 publicDir）
 *
 * ── 与主应用不同的地方，逐条都有理由 ─────────────────────────
 *
 * ① **root 不同**：主应用 root 是项目根（入口 `index.html`）；扩展 root 是
 *    `harbor-edge/src/sidepanel` —— 这样 `index.html` 与 `main.tsx` 同处一层，
 *    Vite 的入口解析、`base: './'` 的相对路径都自然成立。
 *
 * ② **postcss 不同**：显式指向 `harbor-edge/postcss.config.js`（那份指定了扩展的
 *    Tailwind content 范围）。不指定的话 Vite 会往上找到项目根那份 —— 而那份用的是
 *    **主应用**的 config，编不出扩展用到的类（第一步最容易踩的坑）。
 *
 * ③ **产物目录不同**：落 `harbor-edge/dist/sidepanel`，**不碰主应用的 dist/**。
 *
 * ④ **`publicDir` 不同**（第二步加）：指向 `harbor-edge/extension/` ——
 *    `manifest.json` 与 `service-worker.js` 是扩展的**源**，但不是 Vite 的构建入口
 *    （没有 import 关系）。用 publicDir 让它们**原样**拷进产物根，
 *    这样 `dist/sidepanel/` 本身就是一个可直接「加载已解压的扩展」的目录。
 *
 * ⑤ **`@` 别名**（第二步加）：侧边栏直接 import 主应用的
 *    `src/components/ui/Button`（复用组件 = 视觉一致的硬保证）。
 *    别名与 `tsconfig.json` 的 `@/*` 同口径，只是这里由 Vite 解析。
 *
 * ★ `base: './'`：扩展页面由浏览器以 `chrome-extension://<id>/index.html`
 *   加载，绝对路径 `/assets/...` 会解析到扩展根 —— 用相对路径最稳。
 *
 * 用法（在项目根跑）：
 *   npx vite build --config harbor-edge/vite.config.ext.ts
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./src/sidepanel', import.meta.url)),
  base: './',
  plugins: [react()],
  publicDir: fileURLToPath(new URL('./extension', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  css: {
    /*
     * 指向**扩展自己的 postcss.config.js**（必须给文件路径，不是目录 ——
     * 给目录时 Vite 会把它当配置文件去打包，直接报一个看不懂的 postcss 语法错）。
     */
    postcss: fileURLToPath(new URL('./postcss.config.js', import.meta.url)),
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/sidepanel', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
