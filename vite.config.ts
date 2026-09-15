import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  /* Electron 用 file:// 加载 dist/index.html，
     绝对路径 /assets/... 会解析到磁盘根目录，必须是相对路径 */
  base: './',
  plugins: [react()],
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
