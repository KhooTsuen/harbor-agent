import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   应用级操作（退出 / 唤起窗口）

   从 backend.ts 拆出来的：那边已经顶到 300 行，
   而这两个和「配置 / 会话 / 对话」都不是一类东西。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

/** 真的退出（区别于点 × 只是藏到托盘） */
export async function quitApp(): Promise<void> {
  if (!bridge) return
  try {
    await bridge.quitApp()
  } catch {
    /* 正在退出，忽略 */
  }
}

/** 从托盘唤起窗口 */
export async function showWindow(): Promise<void> {
  if (!bridge) return
  try {
    await bridge.showWindow()
  } catch {
    /* 忽略 */
  }
}
