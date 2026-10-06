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
     * ★ 单测里的内核 `.cjs`（日志、配置、规模预检、导航策略…）会写**数据目录**，
     *   而默认那是**应用的真 data** —— 单测的假数据于是灌进用户真日志
     *   （2026-10-07：跑一次 test:unit 主日志 +15 行）。这里给它一个隔离信号，
     *   `paths.cjs` 收到后把 data 切到 `data/unit-test-data`（与自检的
     *   `selftest-data` 同一个套路）。用 env 而不是入口脚本判断：vitest 的 env
     *   在 worker 启动时注入，早于测试模块（进而早于内核 require）求值。
     */
    env: { HARBOR_UNIT_TEST: '1' },
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
