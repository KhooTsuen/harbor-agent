/**
 * 扩展侧 Vite 配置草案（Phase 1c 第一步：构建链路验证）
 *
 * ── 三条与主应用不同的地方 ────────────────────────────────────
 *
 * ① **root 不同**：主应用 root 是项目根（入口 `index.html`）；扩展 root 是
 *    `harbor-edge/src/sidepanel` —— 这样 `index.html` 与 `main.tsx` 同处一层，
 *    Vite 的入口解析、`base: './'` 的相对路径都自然成立。
 *
 * ② **postcss 不同**：显式指向 `harbor-edge/`（那里有一份指定了扩展
 *    Tailwind config 的 postcss.config.js）。不指定的话 Vite 会往上找到
 *    项目根那份 —— 而那份用的是**主应用**的 tailwind config，
 *    编不出扩展用到的类（这是本步最容易踩的坑）。
 *
 * ③ **产物目录不同**：落 `harbor-edge/dist/sidepanel`，**不碰主应用的 dist/**。
 *    扩展是独立交付物，两边的产物永远不该混。
 *
 * ★ `base: './'`：扩展页面由浏览器以 `chrome-extension://<id>/sidepanel/index.html`
 *   加载，绝对路径 `/assets/...` 会解析到扩展根 —— 用相对路径最稳
 *   （与主应用同样的理由，见根 vite.config.ts 的说明）。
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
    /* 扩展页没有 CDN，别把资源转成 data URL 之外的花样；保持默认即可 */
    assetsDir: 'assets',
  },
})
