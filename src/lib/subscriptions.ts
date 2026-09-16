import type { ChatEvent, WorkbenchBridge } from '@/types/backend'

/* 订阅类桥接：和 backend.ts 分开，因为那边已经接近 300 行上限。
   这里只放「主进程 → 渲染层的推送事件」订阅。 */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

/** 订阅对话流式事件（content / reasoning / tool_calls / done 等） */
export function subscribeChatEvents(callback: (event: ChatEvent) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent(callback)
}

/** 插件热插拔事件（新增/删除插件时） */
export function subscribePluginChanges(
  callback: (change: { added: string[]; removed: string[]; count: number }) => void,
): () => void {
  if (!bridge) return () => {}
  return bridge.onPluginsChanged(callback)
}

/**
 * 生图完成 / 失败。
 *
 * 生图是异步的：工具提交完就返回了（上游要排队几分钟），
 * 真正出图时那一轮对话早就结束了 —— 所以靠主进程推回来。
 */
export function subscribeImageDone(
  callback: (payload: {
    taskId: string
    sessionId?: string
    file?: string
    url?: string
    model?: string
    content?: string
    error?: string
    /** 进度事件会带这个：submitted / processing / done / failed */
    status?: string
    elapsedMs?: number
  }) => void,
): () => void {
  if (!bridge?.onImageDone) return () => {}
  return bridge.onImageDone(callback)
}
