import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    /*
     * jsdom 默认每个测试文件建一次 —— 54 个文件就是 54 个 jsdom 实例，
     * 实测占掉 80% 的运行时间（vitest 5 自己会提示这一点）。
     * vmThreads 让每个 worker 只建一次，同时保留文件级隔离（不会互相串状态）。
     */
    pool: 'vmThreads',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/stores/**'],
    },
  },
})
