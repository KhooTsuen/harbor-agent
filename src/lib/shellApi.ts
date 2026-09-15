import type { ShellData, ShellRunResult } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   终端的桥包装

   命令在主进程里真跑，输出通过 shell:data 事件流式推回来。
   没有桥（浏览器预览）时返回 null / 空函数；桌面版始终走真实终端。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/** 订阅流式输出。返回取消订阅的函数 */
export function onShellData(callback: (data: ShellData) => void): () => void {
  if (!bridge) return () => {}
  try {
    return bridge.onShellData(callback)
  } catch {
    return () => {}
  }
}

export async function shellRun(payload: {
  command: string
  requestId: string
  timeout?: number
}): Promise<ShellRunResult | null> {
  if (!bridge) return null
  try {
    return await bridge.shellRun(payload)
  } catch {
    return null
  }
}

export async function shellAbort(requestId: string): Promise<void> {
  if (!bridge) return
  try {
    await bridge.shellAbort(requestId)
  } catch {
    /* 忽略 */
  }
}

export async function shellCwd(): Promise<string | null> {
  if (!bridge) return null
  try {
    return (await bridge.shellCwd()).cwd
  } catch {
    return null
  }
}

export async function shellReset(): Promise<string | null> {
  if (!bridge) return null
  try {
    return (await bridge.shellReset()).cwd
  } catch {
    return null
  }
}
