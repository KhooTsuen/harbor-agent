import { useMemo } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   多选删除

   删除走二次确认：一次删十几条是不可逆的，误触代价太大。

   ⚠️ **状态必须放在模块级 store 里，不能用 useState。**
   踩过：这个 hook 原来内部是 `useState`，而「多选删除」按钮在
   SidebarHeader、列表在 Sidebar —— 两个组件各调一次，就各拿到**一份独立状态**。
   点按钮只把 header 那份的 active 置了 true，Sidebar 读到的还是 false，
   于是两种多选（对话文件夹、单独对话）都进不去，而且不报任何错。

   教训：**一个 hook 只要被两处调用，就不能把状态存在自己里面。**
   ══════════════════════════════════════════════════════════════ */

export interface BulkSelect {
  /** 是否处于多选模式 */
  active: boolean
  selected: ReadonlySet<string>
  start: () => void
  exit: () => void
  toggle: (id: string) => void
  removeSelected: () => void
}

interface BulkSelectState {
  active: boolean
  selected: ReadonlySet<string>
  start: () => void
  exit: () => void
  toggle: (id: string) => void
}

/** 导出 store 本身：非组件的地方（快捷键、测试）也要能驱动它 */
export const bulkSelectStore = create<BulkSelectState>()((set) => ({
  active: false,
  selected: new Set<string>(),
  start: () => set({ active: true, selected: new Set<string>() }),
  exit: () => set({ active: false, selected: new Set<string>() }),
  toggle: (id) =>
    set((state) => {
      const next = new Set(state.selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selected: next }
    }),
}))

/** 删掉选中的那些（二次确认后再动） */
function removeSelected(): void {
  const { selected, exit } = bulkSelectStore.getState()
  const ids = [...selected]
  if (ids.length === 0) return

  useUIStore.getState().askPermission({
    kind: 'delete-thread',
    title: `删除选中的 ${ids.length} 条对话？`,
    description: '这些对话里的消息会一起删掉，不能撤销。',
    confirmText: '删除',
    danger: true,
    onConfirm: () => {
      for (const id of ids) useAppStore.getState().deleteThread(id)
      useUIStore.getState().showToast('success', `已删除 ${ids.length} 条对话`)
      exit()
    },
  })
}

export function useBulkSelect(): BulkSelect {
  const active = bulkSelectStore((s) => s.active)
  const selected = bulkSelectStore((s) => s.selected)
  const start = bulkSelectStore((s) => s.start)
  const exit = bulkSelectStore((s) => s.exit)
  const toggle = bulkSelectStore((s) => s.toggle)

  /* 保持返回对象的引用稳定 —— 叫 useBulkSelect 的地方可能会把它塞进依赖数组 */
  return useMemo(
    () => ({ active, selected, start, exit, toggle, removeSelected }),
    [active, selected, start, exit, toggle],
  )
}
