import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BulkSelectList } from '../BulkSelectList'
import { bulkSelectStore } from '@/hooks/useBulkSelect'
import type { Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   P3 #11 · 对话批量选择

   四条验收，逐条钉：
     · 空结果：没有可点的全选
     · 部分选中 / 全选 / 取消全选：状态与数量都对
     · 全选**只作用于传入的这一批**（不隐含扩展到别处）
     · 数量显示与真实选择一致
   ══════════════════════════════════════════════════════════════ */

const thread = (id: string, title: string): Thread => ({
  id,
  title,
  messages: [],
  mode: 'pair',
  model: '',
  reasoning: 'high',
  status: 'idle',
  tags: [],
  pinned: false,
  archived: false,
  temporary: false,
  createdAt: 1,
  updatedAt: 1,
  projectId: '',
  exportedAt: 0,
})

const list = [thread('t1', '第一条'), thread('t2', '第二条'), thread('t3', '第三条')]

let container: HTMLDivElement
let root: Root

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

const click = (el: Element | null): void => {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

const text = (): string => container.textContent ?? ''

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  bulkSelectStore.setState({ active: true, selected: new Set<string>() })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P3 #11 · 对话批量选择', () => {
  it('空结果：说「没有对话」，不给出可点的全选', () => {
    render(
      <BulkSelectList
        threads={[]}
        selected={new Set()}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(text()).toContain('没有对话')
    expect(container.querySelector('button')).toBeNull()
  })

  it('★ 全选只作用于传入的这一批，数量显示同步', () => {
    /* 外部还有个 t9 不在列表里 —— 全选绝不能把它带上 */
    function Harness(): React.ReactElement {
      const selected = bulkSelectStore((s) => s.selected)
      const selectAll = bulkSelectStore((s) => s.selectAll)
      const clearAll = bulkSelectStore((s) => s.clearAll)
      const toggle = bulkSelectStore((s) => s.toggle)
      return (
        <BulkSelectList
          threads={list}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClearAll={clearAll}
        />
      )
    }
    render(<Harness />)
    expect(text()).toContain('已选 0 / 共 3')
    expect(text()).toContain('全选')

    click(container.querySelector('button')!)
    expect(text()).toContain('已选 3 / 共 3')
    const picked = [...bulkSelectStore.getState().selected]
    expect(picked.sort()).toEqual(['t1', 't2', 't3'])
    expect(picked).not.toContain('t9')
  })

  it('★ 全选之后再点一次 = 取消全选（按钮文案切换）', () => {
    function Harness(): React.ReactElement {
      const selected = bulkSelectStore((s) => s.selected)
      const selectAll = bulkSelectStore((s) => s.selectAll)
      const clearAll = bulkSelectStore((s) => s.clearAll)
      const toggle = bulkSelectStore((s) => s.toggle)
      return (
        <BulkSelectList
          threads={list}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClearAll={clearAll}
        />
      )
    }
    render(<Harness />)
    click(container.querySelector('button')!)
    expect(text()).toContain('取消全选')

    click(container.querySelector('button')!)
    expect(text()).toContain('已选 0 / 共 3')
    expect(bulkSelectStore.getState().selected.size).toBe(0)
  })

  it('部分选中：数量正确，按钮仍是「全选」', () => {
    bulkSelectStore.setState({ selected: new Set(['t2']) })
    render(
      <BulkSelectList
        threads={list}
        selected={new Set(['t2'])}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(text()).toContain('已选 1 / 共 3')
    expect(text()).toContain('全选')
  })

  it('越界的选择不计入当前范围的数量（防隐藏选择误导）', () => {
    render(
      <BulkSelectList
        threads={list}
        selected={new Set(['t1', 't9'])}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
      />,
    )
    /* t9 不在这一批里 → 只报 1 条，不报 2 条 */
    expect(text()).toContain('已选 1 / 共 3')
  })
})
