import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

/*
 * 版本号从 package.json 读进来注入。
 *
 * 踩过：`src/lib/backend.ts` 是 `import.meta.env.VITE_APP_VERSION ?? '0.1.0'`，
 * 而这个环境变量**从来没被设置过** —— 于是「关于」页一直显示硬编码的 **0.1.0**，
 * 而项目早就过了 0.29.0。改了近三十个版本，关于页一次都没变。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  /* Electron 用 file:// 加载 dist/index.html，
     绝对路径 /assets/... 会解析到磁盘根目录，必须是相对路径 */
  base: './',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    open: false,
    /*
     * 开发服务器**必须**绕开这些目录。2026-09-29 实测的崩法：
     * 应用在开发模式下会把 Chromium 配置写进 `data/chromium/`（那是运行时数据），
     * 而 vite 的监视器默认从项目根往下爬 → 撞上被锁的 `data/chromium/Network/Cookies`
     * → `EBUSY: resource busy or locked` → **vite 直接退出**，开发模式起不来。
     *
     * 这些目录都不是源码：data/ 是运行时数据，其余是构建产物 / 临时目录 / 依赖。
     * 顺带也省掉一大堆无意义的文件监视。
     */
    watch: {
      ignored: ['**/data/**', '**/dist/**', '**/dist-portable/**', '**/tmp/**', '**/shots/**', '**/test-env/**', '**/backups/**'],
    },
  },
})
