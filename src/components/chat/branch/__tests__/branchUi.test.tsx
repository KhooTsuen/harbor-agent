import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getForkPoints } from '@/lib/branchPath'
import { ForkBadge } from '../ForkBadge'
import { ForkMenuList } from '../ForkPopover'
import { AnswerVersions } from '@/components/chat/message/AnswerVersions'
import { UserMessage } from '@/components/chat/message/UserMessage'
import { switchBranch } from '@/stores/thread/branchSwitch'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   分支导航界面（验收 e）

   e. 消息旁 L 标：L 层号 + 分支数；点开是同一份兄弟菜单

   ★ P3 #10 撤掉了聊天区顶部那条面包屑（`BranchBreadcrumb`）——
     它原来守的「点某段切分支」改由 L 标与侧栏分支树承担，两者都还在测
     （L 标那两条 + `ForkMenuList` 的限高那条）。切分支本身仍是 `switchBranch`。
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

describe('P3 #10 · 顶部分支导航已移除', () => {
  it('聊天区不再有面包屑组件（文件已删，没人能把它挂回来）', () => {
    /*
     * 不 import 它（vite 会在 transform 阶段就解析动态 import 直接失败），
     * 直接看文件在不在 —— 这比「渲染后断言 DOM 里没有」更硬：
     * DOM 断言只能证明「这次没渲染」，文件不在了才证明「挂不回来」。
     */
    const dir = resolve(__dirname, '..')
    expect(existsSync(join(dir, 'BranchBreadcrumb.tsx'))).toBe(false)
  })

  it('切分支的能力仍在：L 标菜单里选另一条 → switchBranch 调用（带 fork + 序号）', () => {
    render(<ForkBadge fork={forks[0]!} />)
    click(container.querySelector('button[aria-label="分支 L1"]'))

    const menu = document.body.querySelector('[data-fork-menu="1"]')
    expect(menu).toBeTruthy()
    const options = menu!.querySelectorAll('[role="menuitem"]')
    expect(options).toHaveLength(2)

    click(options[0] as Element)
    expect(vi.mocked(switchBranch)).toHaveBeenCalledWith(forks[0], 0)
  })

  it('选「当前」那条不动作（免得白写一遍盘）', () => {
    render(<ForkBadge fork={forks[0]!} />)
    click(container.querySelector('button[aria-label="分支 L1"]'))
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
