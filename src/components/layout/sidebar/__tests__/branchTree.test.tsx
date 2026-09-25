import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/stores/useAppStore'
import { getForkPoints } from '@/lib/branchPath'
import { switchBranch } from '@/stores/thread/branchSwitch'
import { SidebarBranchTree } from '../SidebarBranchTree'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   侧栏分支树（验收 c / d）

   c. 默认折叠、展开后按 L1/L2…列出分叉点与兄弟分支，当前那条高亮
   d. 点别的分支 → switchBranch 调用（带 fork + 序号）
   ══════════════════════════════════════════════════════════════ */

vi.mock('@/stores/thread/branchSwitch', () => ({ switchBranch: vi.fn() }))

const msg = (over: Partial<Message>): Message => ({
  id: 'm',
  threadId: 't1',
  role: 'assistant',
  content: '',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

const thread = (messages: Message[]): Thread => ({
  id: 't1',
  projectId: 'p1',
  title: '自检对话',
  messages,
  status: 'idle',
  mode: 'pair',
  model: 'probe',
  reasoning: 'high',
  pinned: false,
  archived: false,
  tags: [],
  exportedAt: 0,
  createdAt: 1,
  updatedAt: 1,
})

const multiFork = (): Message[] => [
  msg({
    id: 'q1',
    role: 'user',
    content: 'B 内容（第二版）',
    versions: ['A 内容（第一版）', 'B 内容（第二版）'],
    versionIndex: 1,
    timestamp: 1,
  }),
  msg({
    id: 'a1',
    content: 'B 的第二条回答',
    answersKey: 'q1',
    answersVersion: 1,
    answerIndex: 1,
    answerRecords: [
      { role: 'assistant', key: 'r1', content: 'B 的第一条回答', answersVersion: 1, ts: 1 },
    ],
    timestamp: 2,
  }),
  msg({
    id: 'q2',
    role: 'user',
    content: '第三版提问',
    versions: ['一版', '二版', '三版'],
    versionIndex: 2,
    timestamp: 3,
  }),
]

const forks = getForkPoints(multiFork())

let container: HTMLDivElement
let root: Root

const click = (el: Element | null): void => {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(switchBranch).mockClear()
  useAppStore.setState({
    threads: [thread(multiFork())],
    activeThreadId: 't1',
    projects: [],
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const openTree = (): Element => {
  act(() => root.render(<SidebarBranchTree />))
  click(container.querySelector('button[aria-label="分支树"]'))
  return container.querySelector('[role="tree"]')!
}

describe('分支树（验收 c）', () => {
  it('c · 默认折叠；展开后列出 L1/L2/L3 与兄弟分支，当前那条高亮', () => {
    act(() => root.render(<SidebarBranchTree />))
    expect(container.querySelector('[role="tree"]')).toBeFalsy()
    expect(container.textContent).toContain('3 个分叉点')

    click(container.querySelector('button[aria-label="分支树"]'))
    const tree = container.querySelector('[role="tree"]')!
    expect(tree.textContent).toContain('L1')
    expect(tree.textContent).toContain('L2')
    expect(tree.textContent).toContain('L3')
    expect(tree.textContent).toContain('提问 1')
    expect(tree.textContent).toContain('答复 1')
    expect(tree.textContent).toContain('提问 2')
    /* 分叉点默认展开：兄弟分支的预览直接可见 */
    expect(tree.textContent).toContain('A 内容（第一版）')
    expect(tree.textContent).toContain('B 内容（第二版）')
    /* 当前路径高亮：每个分叉点恰好一条 active */
    expect(tree.querySelectorAll('[data-branch-node="active"]')).toHaveLength(3)
    expect(
      (tree.querySelector('[data-branch-node="active"]')?.textContent ?? '').includes('B 内容'),
    ).toBe(true)
  })

  it('没有分叉时给一句说明（不画空树）', () => {
    useAppStore.setState({
      threads: [thread([])],
      activeThreadId: 't1',
      projects: [],
    } as never)
    const tree = openTree()
    expect(tree.textContent).toContain('还没有分叉')
  })
})

describe('点节点跳分支（验收 d）', () => {
  it('d · 点别的分支 → switchBranch（带 fork + 序号）', () => {
    const tree = openTree()
    const idle = [...tree.querySelectorAll('[data-branch-node="idle"]')].find((el) =>
      (el.textContent ?? '').includes('A 内容（第一版）'),
    )
    click(idle as Element)
    expect(vi.mocked(switchBranch)).toHaveBeenCalledWith(forks[0], 0)
  })

  it('点当前分支不重复切换', () => {
    const tree = openTree()
    click(tree.querySelector('[data-branch-node="active"]'))
    expect(vi.mocked(switchBranch)).not.toHaveBeenCalled()
  })

  it('折叠某个分叉点 → 它的兄弟分支收起', () => {
    const tree = openTree()
    /* 标题行是分叉点里的**按钮**（外面的 div 只是 treeitem 容器，点它没反应） */
    const header = [...tree.querySelectorAll('button')].find((el) =>
      (el.textContent ?? '').includes('提问 1'),
    )
    click(header as Element)
    expect(tree.querySelectorAll('[role="treeitem"][aria-expanded="false"]')).toHaveLength(1)
  })
})
