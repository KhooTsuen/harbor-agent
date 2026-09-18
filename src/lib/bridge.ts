import type { WorkbenchBridge } from '@/types/backend'

/*
 * 后端桥 + 运行环境判断。
 *
 * 单独一个文件是为了**打破循环依赖**：`backend.ts` 和 `chatControl.ts`
 * 都要拿 `bridge`。如果 bridge 留在 backend.ts 里，chatControl 就得反过来
 * import backend，而 backend 又要 re-export chatControl —— 成环。
 *
 * 调用方一般不用直接 import 这里（backend.ts 会 re-export），
 * 只有需要绕开环的模块才用它。
 */

export const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

export const isElectron = Boolean(bridge)

/* 生产构建永远用真实后端；mock 只能在 Vite 开发服务器里显式开启，
   免得便携版被一个环境变量误切成演示模式。 */
export const useRealBackend =
  isElectron && !(import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === '1')
