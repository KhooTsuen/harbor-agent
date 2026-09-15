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
