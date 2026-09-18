import { bridge } from './bridge'

/*
 * 「跟正在跑的那一轮打交道」的几条命令（AG-011 从 backend.ts 拆出来）。
 *
 * 拆的理由有两个：backend.ts 顶到 300 行上限了；而且这三个（中断 / 暂停 /
 * 确认答复）本来就是同一类东西 —— 它们都作用于**当前正在执行的那次请求**，
 * 而不是配置或会话。
 *
 * ★ 中断和暂停是两件事，别混：
 *     abort  —— 立刻断，正在跑的命令会被杀掉（连同子进程）
 *     pause  —— 先把手上这一步做完，在下一个安全点停住，之后可以接着做
 */

export async function abortChat(requestId: string): Promise<void> {
  if (!bridge) return
  try {
    await bridge.abortChat(requestId)
  } catch {
    /* 中断失败没什么可做的 */
  }
}

export async function pauseChat(requestId: string): Promise<void> {
  if (!bridge) return
  try {
    await bridge.pauseChat(requestId)
  } catch {
    /* 暂停失败没什么可做的 */
  }
}
