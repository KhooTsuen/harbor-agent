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
  /** P3 #11：全选**当前可见范围内的**（不是全部对话 —— 不能隐含扩展到未展示范围） */
  selectAll: (ids: readonly string[]) => void
  /** P3 #11：取消全选（只清选择，不退出多选模式） */
  clearAll: () => void
  removeSelected: () => void
}

interface BulkSelectState {
  active: boolean
  selected: ReadonlySet<string>
  start: () => void
  exit: () => void
  toggle: (id: string) => void
  selectAll: (ids: readonly string[]) => void
  clearAll: () => void
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
  /*
   * P3 #11：全选 / 取消全选都**只认传进来的这批 id**。
   *
   * ★ 为什么不在这里去读「全部对话」：调用方传的就是**当前筛选 / 搜索之后**
   *   显示出来的那批。在这里自己再算一次范围，早晚会和界面上看到的不一致，
   *   而「选中的比看到的多」正是批量删除最危险的一种状态。
   */
  selectAll: (ids) => set({ selected: new Set(ids) }),
  clearAll: () => set({ selected: new Set<string>() }),
}))

/** 删掉选中的那些（二次确认后再动） */
function removeSelected(): void {
  const { selected, exit } = bulkSelectStore.getState()
  const ids = [...selected]
  if (ids.length === 0) return

  const idSet = new Set(ids)
  useUIStore.getState().askPermission({
    kind: 'delete-thread',
    title: `删除选中的 ${ids.length} 条对话？`,
    description: '这些对话里的消息会一起删掉，不能撤销。',
    confirmText: '删除',
    danger: true,
    onConfirm: () => {
      void (async () => {
        /*
         * P3 #11：逐条删、**数出真的删掉了几条**。
         * 以前是 `for (...) deleteThread(id)` 之后无条件报「已删除 N 条」——
         * 有失败也照样说全成功。现在如实报：全成 / 部分成功 / 全失败分开说。
         */
        let done = 0
        const failed: string[] = []
        for (const id of ids) {
          const title = useAppStore.getState().threads.find((t) => t.id === id)?.title ?? id
          try {
            await useAppStore.getState().deleteThread(id)
            done += 1
          } catch {
            failed.push(title)
          }
        }
        /* 没删掉的仍在列表里 → 选择只留它们，用户可以直接重试 */
        if (failed.length > 0) {
          const left = useAppStore
            .getState()
            .threads.filter((t) => idSet.has(t.id))
            .map((t) => t.id)
          bulkSelectStore.setState({ selected: new Set(left) })
          useUIStore
            .getState()
            .showToast(
              'error',
              `删除了 ${done} 条，${failed.length} 条没删掉`,
              `没删掉：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ` 等 ${failed.length} 条` : ''}`,
            )
          return
        }
        useUIStore.getState().showToast('success', `已删除 ${done} 条对话`)
        exit()
      })()
    },
  })
}

export function useBulkSelect(): BulkSelect {
  const active = bulkSelectStore((s) => s.active)
  const selected = bulkSelectStore((s) => s.selected)
  const start = bulkSelectStore((s) => s.start)
  const exit = bulkSelectStore((s) => s.exit)
  const toggle = bulkSelectStore((s) => s.toggle)
  const selectAll = bulkSelectStore((s) => s.selectAll)
  const clearAll = bulkSelectStore((s) => s.clearAll)

  /* 保持返回对象的引用稳定 —— 叫 useBulkSelect 的地方可能会把它塞进依赖数组 */
  return useMemo(
    () => ({ active, selected, start, exit, toggle, selectAll, clearAll, removeSelected }),
    [active, selected, start, exit, toggle, selectAll, clearAll],
  )
}
