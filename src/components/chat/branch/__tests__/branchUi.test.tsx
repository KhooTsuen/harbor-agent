import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getForkPoints } from '@/lib/branchPath'
import { BranchBreadcrumb } from '../BranchBreadcrumb'
import { ForkBadge } from '../ForkBadge'
import { ForkMenuList } from '../ForkPopover'
import { AnswerVersions } from '@/components/chat/message/AnswerVersions'
import { UserMessage } from '@/components/chat/message/UserMessage'
import { switchBranch } from '@/stores/thread/branchSwitch'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分支导航界面（验收 a / b / e）

   a. 面包屑列全部分叉点
   b. 点面包屑某段 → 弹出兄弟菜单 → 选一条 → switchBranch 被调用
      （「整条后续链跟着切换」是 switchBranch 两个动作自己的既有行为）
   e. 消息旁 L 标：L 层号 + 分支数；点开是同一份菜单
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

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll('[data-fork-menu]').forEach((el) => el.remove())
})

describe('面包屑（验收 a）', () => {
  it('a · 显示路径上全部分叉点 + 主干 + 当前', () => {
    render(<BranchBreadcrumb forks={forks} />)
    const text = container.textContent ?? ''
    expect(text).toContain('主干')
    expect(text).toContain('提问 1 · 2/2')
    expect(text).toContain('答复 1 · 2/2')
    expect(text).toContain('提问 2 · 3/3')
    expect(text).toContain('当前')
    expect(container.querySelectorAll('[data-branch-crumb]')).toHaveLength(3)
  })

  it('没有分叉 → 整条不渲染（不给界面添噪音）', () => {
    render(<BranchBreadcrumb forks={[]} />)
    expect(container.querySelector('[data-branch-breadcrumb]')).toBeFalsy()
  })
})

describe('点面包屑切分支（验收 b）', () => {
  it('b · 点开某段 → 兄弟菜单 → 选另一条 → switchBranch 调用（带 fork + 序号）', () => {
    render(<BranchBreadcrumb forks={forks} />)
    click(container.querySelector('[data-branch-crumb="1"]'))

    const menu = document.body.querySelector('[data-fork-menu="1"]')
    expect(menu).toBeTruthy()
    const options = menu!.querySelectorAll('[role="menuitem"]')
    expect(options).toHaveLength(2)

    click(options[0] as Element)
    expect(vi.mocked(switchBranch)).toHaveBeenCalledWith(forks[0], 0)
  })

  it('选「当前」那条不动作（免得白写一遍盘）', () => {
    render(<BranchBreadcrumb forks={forks} />)
    click(container.querySelector('[data-branch-crumb="1"]'))
    const options = document.body.querySelectorAll('[data-fork-menu="1"] [role="menuitem"]')
    click(options[1] as Element)
    expect(vi.mocked(switchBranch)).not.toHaveBeenCalled()
  })
})

describe('层级指示器（验收 e）', () => {
  it('e · L 标显示层号 + 分支数', () => {
    render(<ForkBadge fork={forks[1]!} />)
    expect(container.textContent).toContain('L2 · 2')
    expect(container.querySelector('[data-fork-badge="2"]')).toBeTruthy()
  })

  it('e · 点 L 标展开这一层的全部分支', () => {
    render(<ForkBadge fork={forks[0]!} />)
    click(container.querySelector('button[aria-label="分支 L1"]'))
    expect(document.body.querySelector('[data-fork-menu="1"]')).toBeTruthy()
    expect(document.body.querySelectorAll('[data-fork-menu="1"] [role="menuitem"]')).toHaveLength(2)
  })

  it('e · 回答旁边挂着 L 标（AnswerVersions 里）', () => {
    render(<AnswerVersions message={multiFork()[1]!} fork={forks[1]} />)
    expect(container.querySelector('[data-fork-badge="2"]')).toBeTruthy()
  })

  it('e · 提问旁边挂着 L 标（UserMessage 里）', () => {
    render(<UserMessage message={multiFork()[0]!} fork={forks[0]} />)
    expect(container.querySelector('[data-fork-badge="1"]')).toBeTruthy()
  })
})

describe('重复生成很多版本时：菜单限高 + 滚动（用户定过的规格）', () => {
  /* 15 条版本 = 重复重新生成的样子 —— 列表区必须带上限与纵向滚动，别把菜单撑出屏幕 */
  const manyFork = (): ReturnType<typeof getForkPoints>[number] => {
    const records = Array.from({ length: 14 }, (_, i) => ({
      role: 'assistant' as const,
      key: `mb${i + 1}`,
      content: `第 ${i + 1} 条回答（探针）—— 重复生成后的版本`,
      answersVersion: 0,
      ts: i,
    }))
    const messages = [
      msg({ id: 'mq', role: 'user', content: '重复生成很多次', timestamp: 0 }),
      msg({
        id: 'ma',
        content: '第 15 条回答（自己）',
        answersKey: 'mq',
        answersVersion: 0,
        answerIndex: 14,
        answerRecords: records,
        timestamp: 1,
      }),
    ]
    return getForkPoints(messages)[0]!
  }

  it('列表区带高度上限（18rem）+ 纵向滚动 + 滚到尽头不带动外层', () => {
    render(<ForkMenuList fork={manyFork()} onPick={() => {}} />)
    const menu = container.querySelector('[data-fork-menu="1"]')!
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(15)
    expect(menu.className).toContain('max-h-72')
    expect(menu.className).toContain('overflow-y-auto')
    expect(menu.className).toContain('overscroll-contain')
  })
})
