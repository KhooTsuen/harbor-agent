import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AboveInputCards } from '../AboveInputCards'
import { useUIStore } from '@/stores/useUIStore'
import type { ClarifyReply, PermissionRequest } from '@/types'

/* ══════════════════════════════════════════════════════════════
   P0-2 的验收里点着名要的一条：**答完之后 UI 重渲，卡片不许复活**

   用户报的「答完卡还在」当时给了三种可能（答案没发出 / 状态没落地 / 只读卡的观感）。
   真机复现把结论钉在第三种（只读卡）上了；但另外两种可能也得有一条测试挡着 ——
   不然以后某次 refactor 让 `clarify` 槽位「答完不关」，界面表现会和当初那个 bug 一模一样。

   做法：真挂载卡片槽 → 真的点「就这么干」→ 触发几次无关重渲 → 断言交互卡一直不在。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root
let replies: ClarifyReply[]

const CARD: PermissionRequest = {
  kind: 'clarify',
  confirmId: 'clr_1',
  title: '动手前先对齐一下',
  description: '',
  confirmText: '就这么干',
  danger: false,
  clarify: [
    {
      question: '用哪个包管理器？',
      options: [
        { label: 'pnpm', effect: '仓库里有 lock 文件' },
        { label: 'npm', effect: '要重新生成 lock' },
      ],
      allowFreeform: false,
      defaultValue: 'pnpm',
      defaultFrom: 'model',
    },
  ],
}

function draw(): void {
  act(() => root.render(<AboveInputCards />))
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))
}

beforeEach(() => {
  replies = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /* jsdom 不实现 scrollIntoView（真浏览器里才有）—— 不 stub 的话「亮卡片」那一下会抛 */
  Element.prototype.scrollIntoView = () => {}
  useUIStore.setState({
    permission: null,
    clarify: {
      ...CARD,
      /* 和真接线一致（`stores/thread/confirmEvents.ts` 的 onClarify）：先收卡，再回话 */
      onClarify: (reply) => {
        replies.push(reply)
        useUIStore.getState().closeClarify('clr_1')
      },
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('答完之后卡片不复活（P0-2 验收）', () => {
  it('★ 点了「就这么干」之后，几次无关重渲都不会把卡叫回来', () => {
    draw()
    expect(container.textContent).toContain('动手前先对齐一下')

    act(() => button('就这么干')?.click())
    expect(replies).toHaveLength(1)
    expect(container.textContent ?? '').not.toContain('动手前先对齐一下')

    /* 三种最常见的「无关重渲」：换右栏标签 / 请卡片亮一下 / 整棵树重挂 */
    act(() => useUIStore.setState({ activeRightTab: 'tasks' }))
    act(() => useUIStore.getState().requestCardFocus())
    draw()

    expect(container.textContent ?? '').not.toContain('动手前先对齐一下')
    expect(container.textContent ?? '').not.toContain('用哪个包管理器？')
  })

  it('答完之后再来一张**新**卡，照样显示（别把「不复活」做成「再也不显示」）', () => {
    draw()
    act(() => button('就这么干')?.click())
    act(() =>
      useUIStore.setState({
        clarify: { ...CARD, confirmId: 'clr_2', onClarify: (reply) => replies.push(reply) },
      }),
    )
    expect(container.textContent).toContain('动手前先对齐一下')
    expect(container.textContent).toContain('用哪个包管理器？')
  })
})
