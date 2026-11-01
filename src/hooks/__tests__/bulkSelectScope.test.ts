import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bulkSelectStore } from '@/hooks/useBulkSelect'

/* ══════════════════════════════════════════════════════════════
   第二阶段：多选删除的「可见范围」一致性

   要钉住的是这一句：**搜索结果、全选数量、确认框数量、实际删除对象
   必须是同一批**；改变搜索条件后，不得暗中保留将被删除的不可见选项。

   以前的问题：`Sidebar` 把**全部对话**传给多选列表，于是搜索出 3 条、
   点「全选」，选中的是 30 条 —— 确认框也说 30 条。看不见的也被删了。

   这里测的是纯状态机（`restrictTo`），不渲染组件：
   组件那一层只需要保证「可见变了就调它」，那一句由 phase2Display 的
   源码守卫盯着。
   ══════════════════════════════════════════════════════════════ */

beforeEach(() => {
  bulkSelectStore.getState().exit()
})

afterEach(() => {
  bulkSelectStore.getState().exit()
})

const selected = (): string[] => [...bulkSelectStore.getState().selected].sort()

describe('多选：可见范围变了，选择跟着裁', () => {
  it('★ 先全选 5 条，搜索收窄到 2 条 → 只剩这 2 条被选中', () => {
    const all = ['a', 'b', 'c', 'd', 'e']
    bulkSelectStore.getState().start()
    bulkSelectStore.getState().selectAll(all)
    expect(selected()).toEqual(all)

    /* 改搜索词之后，界面上只剩 a、c（比如标题里都带「构建」） */
    bulkSelectStore.getState().restrictTo(['a', 'c'])
    expect(selected()).toEqual(['a', 'c'])
  })

  it('★ 收窄之后确认框拿到的就是 2 条 —— 数量与选中是一份数据', () => {
    bulkSelectStore.getState().start()
    bulkSelectStore.getState().selectAll(['a', 'b', 'c'])
    bulkSelectStore.getState().restrictTo(['b'])
    /* removeSelected 读的就是 selected.size，这里直接钉住那个来源 */
    expect(bulkSelectStore.getState().selected.size).toBe(1)
  })

  it('范围扩大不新增选择（只裁不加）', () => {
    bulkSelectStore.getState().start()
    bulkSelectStore.getState().selectAll(['b'])
    bulkSelectStore.getState().restrictTo(['a', 'b', 'c'])
    expect(selected()).toEqual(['b'])
  })

  it('没有选择时不动 state（避免每次渲染都造新 Set、白重渲染）', () => {
    bulkSelectStore.getState().start()
    const before = bulkSelectStore.getState().selected
    bulkSelectStore.getState().restrictTo(['a'])
    expect(bulkSelectStore.getState().selected).toBe(before)
  })

  it('选择全都在范围内时也保持同一个 Set（引用不变）', () => {
    bulkSelectStore.getState().start()
    bulkSelectStore.getState().selectAll(['a'])
    const before = bulkSelectStore.getState().selected
    bulkSelectStore.getState().restrictTo(['a', 'b'])
    expect(bulkSelectStore.getState().selected).toBe(before)
  })

  it('范围被清空（搜索无结果）→ 选择也清空，不会留下看不见的待删项', () => {
    bulkSelectStore.getState().start()
    bulkSelectStore.getState().selectAll(['a', 'b'])
    bulkSelectStore.getState().restrictTo([])
    expect(bulkSelectStore.getState().selected.size).toBe(0)
  })
})
