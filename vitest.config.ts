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
    setupFiles: ['./vitest.setup.ts'],
    /*
     * jsdom 默认每个测试文件建一次 —— 文件一多就是几十个 jsdom 实例，
     * 实测占掉 80% 的运行时间（vitest 5 自己会提示这一点）。
     * vmThreads 让每个 worker 只建一次，同时保留文件级隔离（不会互相串状态）。
     */
    pool: 'vmThreads',
    /*
     * CI 偶发「单个测试卡满 30 秒」：同一份代码（2c39caf）第一次跑 330 秒卡死、
     * 重跑 21 秒全过 —— 是 runner 环境抖动，不是测试本身写错。
     * 失败自动重试一次即可带过；本地正常时不会触发，耗时不变。
     */
    retry: 1,
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/stores/**'],
    },
  },
})
