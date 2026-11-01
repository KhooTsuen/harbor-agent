import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   助手行为开关（真渲染）

   这一组的由来：**配置躺在那里、却没界面也没行为** ——
   AG-053 之前有四个开关是这样（`planFirst` / `clarifyFirst` /
   `verifyAfterEdit` / `streamOutput`），其中三个在 2026-09-30 接上，
   `clarifyFirst` 到批④ 才有界面。

   所以这里钉的不是「长得对不对」，而是**点一下真的写到配置里**：
   界面上显示成开、磁盘上却是关（或者反过来），用户是看不出来的 ——
   这正是那个月栽过好几次的病。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  pushed: [] as Array<Record<string, unknown>>,
  assistant: {
    name: 'Agent',
    planFirst: true,
    clarifyFirst: true,
    verifyAfterEdit: true,
    strictMode: false,
    streamOutput: true,
  },
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    isElectron: true,
    loadConfig: async () => ({ assistant: { ...h.assistant } }),
    /* 假内核：记下交上来的 patch，并按真实内核那样合并回来 */
    pushConfig: async (patch: Record<string, unknown>) => {
      h.pushed.push(patch)
      h.assistant = { ...h.assistant, ...(patch.assistant as typeof h.assistant) }
      return { assistant: { ...h.assistant } }
    },
  }
})

import { useConfigStore } from '@/stores/useConfigStore'
import { AssistantSwitches } from '../providers/AssistantSwitches'

let container: HTMLDivElement
let root: Root

/** 按标签文字找那个开关（四个长得一样，只能按文字找） */
function toggleBy(label: string): HTMLInputElement {
  const all = [...container.querySelectorAll('label')]
  const hit = all.find((one) => (one.textContent ?? '').includes(label))
  const box = hit?.querySelector('input[type="checkbox"]')
  if (!box) throw new Error(`没找到开关：${label}`)
  return box as HTMLInputElement
}

/** 点一下：React 认的是 native setter + change 事件 */
function click(box: HTMLInputElement): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set
  act(() => {
    setter?.call(box, !box.checked)
    box.dispatchEvent(new Event('click', { bubbles: true }))
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('助手开关', () => {
  beforeEach(async () => {
    h.pushed = []
    h.assistant = {
      name: 'Agent',
      planFirst: true,
      clarifyFirst: true,
      verifyAfterEdit: true,
      strictMode: false,
      streamOutput: true,
    }
    useConfigStore.setState({ config: { assistant: { ...h.assistant } } as never })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<AssistantSwitches />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('★ 默认是开着的（配置里没写也算开 —— 老用户不该被默认关掉）', () => {
    expect(toggleBy('开工前先问清楚').checked).toBe(true)
  })

  it('★ 点一下真的写进配置（不只是界面上变了）', async () => {
    click(toggleBy('开工前先问清楚'))
    await act(async () => {})
    expect((h.pushed.at(-1) as { assistant: Record<string, unknown> }).assistant).toEqual({
      clarifyFirst: false,
    })
  })

  it('再点一下能开回来（这个开关也是这一条的回滚开关）', async () => {
    click(toggleBy('开工前先问清楚'))
    await act(async () => {})
    click(toggleBy('开工前先问清楚'))
    await act(async () => {})
    expect((h.pushed.at(-1) as { assistant: Record<string, unknown> }).assistant).toEqual({
      clarifyFirst: true,
    })
  })

  it('四个开关各改各的（改一个不动别的）', async () => {
    click(toggleBy('先给计划再动手'))
    await act(async () => {})
    expect((h.pushed.at(-1) as { assistant: Record<string, unknown> }).assistant).toEqual({
      planFirst: false,
    })
    expect(
      (h.pushed.at(-1) as { assistant: Record<string, unknown> }).assistant,
    ).not.toHaveProperty('clarifyFirst')
  })

  it('★ 严格模式（CE-008）：默认关；点一下真的写进配置', async () => {
    expect(toggleBy('严格模式').checked).toBe(false)
    click(toggleBy('严格模式'))
    await act(async () => {})
    expect((h.pushed.at(-1) as { assistant: Record<string, unknown> }).assistant).toEqual({
      strictMode: true,
    })
  })

  it('★ 每个开关下面都写明按下去会发生什么（不许有「按了没反应」的开关）', () => {
    /* 2026-11-01 用户原话：「我以为像真正的开关一样，按一下会改变状态」——
       几个开关长得一模一样，不写清哪一层生效就只能靠猜。
       这里钉两件事：① 每个带 checkbox 的 label 都有一行小字；
       ② 小字里必须说清是「真的会拦」还是「真的生效」，
       ——不能写回「只影响给模型的说明」这种软话（那正是这次要消掉的情况）。 */
    const boxes = [...container.querySelectorAll('label')].filter((one) =>
      one.querySelector('input[type="checkbox"]'),
    )
    expect(boxes.length).toBeGreaterThanOrEqual(6)
    for (const box of boxes) {
      const hint = box.querySelector('span.text-2xs')?.textContent ?? ''
      expect(hint.length).toBeGreaterThan(8)
      expect(hint).toMatch(/真的会拦|真的生效/)
    }
  })

  it('没有配置（浏览器预览）时整块不渲染，不显示一堆假开关', async () => {
    await act(async () => {
      useConfigStore.setState({ config: null })
    })
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })
})
