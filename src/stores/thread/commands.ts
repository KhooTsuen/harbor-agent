import { runCompact } from './compact'
import { getActiveThread, useAppStore } from '../useAppStore'
import { useThreadStore } from '../useThreadStore'
import { useUIStore } from '../useUIStore'

/*
 * 斜杠命令（/compact /temporary /new /clear /readonly…）。
 *
 * 从 useThreadStore 抽出来：那边又加了队列、草稿，行数顶格了。
 * 命令处理是纯「字符串判断 + 动作」，独立性最强，抽出来最不伤结构。
 *
 * 这里用 getState() 访问各 store（运行时调用）—— 因为 useThreadStore 也会
 * import 本文件（sendMessage 里调 tryHandleCommand），两边互相 import，
 * 只要不在模块顶层用对方导出就没事。
 */

/** 返回 true 表示已处理（调用方应该 return，不再当普通消息发） */
export function tryHandleCommand(raw: string): boolean {
  const threadStore = useThreadStore.getState()
  const app = useAppStore.getState()
  const ui = useUIStore.getState()

  if (raw === '/compact') {
    threadStore.clearInput()
    threadStore.clearInputImages()
    const current = getActiveThread(app)
    if (current) void runCompact(current.id)
    return true
  }

  if (raw === '/temporary') {
    threadStore.clearInput()
    const current = getActiveThread(app)
    if (current) {
      useAppStore.setState((s) => ({
        threads: s.threads.map((t) => (t.id === current.id ? { ...t, temporary: true } : t)),
      }))
      ui.showToast('info', '临时对话', '本次对话不会写入长期记忆')
    }
    return true
  }

  if (raw === '/new') {
    threadStore.clearInput()
    app.createThread()
    return true
  }

  /* 彩蛋：/harbor —— 本地统计面板（数据来自任务台账，见 HarborStatsModal） */
  if (raw === '/harbor') {
    threadStore.clearInput()
    ui.openHarborStats()
    return true
  }

  if (raw === '/clear') {
    threadStore.clearInput()
    const current = getActiveThread(app)
    if (current) app.clearMessages(current.id)
    return true
  }

  if (raw === '/readonly' || raw === '/agent' || raw === '/research') {
    threadStore.clearInput()
    const current = getActiveThread(app)
    const next =
      raw.slice(1) === 'readonly' ? 'plan' : raw.slice(1) === 'research' ? 'plan' : 'execute'
    if (current) app.setThreadMode(current.id, next)
    return true
  }

  return false
}
