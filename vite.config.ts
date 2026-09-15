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
  },
})
